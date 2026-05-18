import XLSX from 'xlsx';
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import Team from '../models/teamGroup.model.js';
import TeamMember from '../models/team.model.js';
import TeamImportLog from '../models/teamImportLog.model.js';
import { isIgnoredEmployee } from '../utils/teamImportPatterns.js';
import { normalizeRows } from '../utils/normalizeTeamRows.js';
import { s3Client, generatePresignedDownloadUrl } from '../config/s3.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

export const REQUIRED_HEADERS = ['Team Name'];
export const MAX_ROWS_PER_IMPORT = 5000;

/**
 * Parse an uploaded Excel workbook buffer for the Teams bulk import flow.
 *
 * Validates:
 *  - workbook contains at least one sheet
 *  - first sheet has at least one data row
 *  - row count does not exceed MAX_ROWS_PER_IMPORT (5000)
 *  - required headers (REQUIRED_HEADERS) are present on row 1
 *
 * Throws ApiError(400) with a structured `errors[]` describing the violation.
 * @param {Buffer} buffer raw xlsx file bytes
 * @returns {{ rows: Array<Record<string, any>> }}
 */
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (!wb.SheetNames.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'empty_sheet' },
    ]);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'empty_sheet' },
    ]);
  }
  if (rows.length > MAX_ROWS_PER_IMPORT) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'row_limit_exceeded', limit: MAX_ROWS_PER_IMPORT, received: rows.length },
    ]);
  }
  const headers = Object.keys(rows[0] || {});
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Invalid Excel file',
      false,
      undefined,
      missing.map((header) => ({ type: 'missing_header', header }))
    );
  }
  return { rows };
}

/**
 * Match a single row to an Employee using a 4-tier priority:
 *   0. employeeInternalId   (Mongo _id)
 *   1. employeeId           (DBS… code, case-insensitive)
 *   2. employeeEmail        (case-insensitive)
 *   3. employeeName         (only if exactly one match — ambiguity blocks)
 *
 * Returns either `{ matched: <employeeDoc> }` or
 * `{ matched: null, skipReason: <string>, matchCount?: <number> }`.
 */
export function _matchOne(row, lookups) {
  if (row.employeeInternalId) {
    const m = lookups.byInternalId.get(String(row.employeeInternalId));
    if (m) return { matched: m };
  }
  if (row.employeeId) {
    const m = lookups.byEmployeeId.get(String(row.employeeId).toUpperCase());
    if (m) return { matched: m };
  }
  if (row.employeeEmail) {
    const m = lookups.byEmail.get(String(row.employeeEmail).toLowerCase());
    if (m) return { matched: m };
  }
  if (row.employeeName) {
    const list = lookups.byName.get(String(row.employeeName).toLowerCase().trim()) || [];
    if (list.length === 1) return { matched: list[0] };
    if (list.length > 1)
      return { matched: null, skipReason: 'ambiguous_employee_name', matchCount: list.length };
  }
  if (!row.employeeInternalId && !row.employeeId && !row.employeeEmail && !row.employeeName)
    return { matched: null, skipReason: 'missing_identifiers' };
  return { matched: null, skipReason: 'employee_not_found' };
}

/**
 * Apply `_matchOne` to each row, returning new row objects with
 * `matched` (and optionally `skipReason` / `matchCount`) merged in.
 */
export function resolveEmployeesFromRows(rows, lookups) {
  return rows.map((r) => ({ ...r, ..._matchOne(r, lookups) }));
}

/**
 * Build the four lookup maps required by `_matchOne` from a single
 * Employee.find query that unions all identifier candidates across rows.
 */
export async function buildEmployeeLookups(rows) {
  const ids = [...new Set(rows.map((r) => r.employeeInternalId).filter(Boolean))];
  const dbsIds = [
    ...new Set(
      rows
        .map((r) => r.employeeId)
        .filter(Boolean)
        .map((s) => s.toUpperCase())
    ),
  ];
  const emails = [
    ...new Set(
      rows
        .map((r) => r.employeeEmail)
        .filter(Boolean)
        .map((s) => s.toLowerCase())
    ),
  ];
  const names = [...new Set(rows.map((r) => r.employeeName).filter(Boolean))];

  const docs = await Employee.find({
    $or: [
      ids.length ? { _id: { $in: ids } } : null,
      dbsIds.length ? { employeeId: { $in: dbsIds } } : null,
      emails.length ? { email: { $in: emails } } : null,
      names.length ? { name: { $in: names } } : null,
    ].filter(Boolean),
  })
    .select('_id employeeId name email isActive department position')
    .lean();

  const byInternalId = new Map(docs.map((d) => [String(d._id), d]));
  const byEmployeeId = new Map(
    docs.filter((d) => d.employeeId).map((d) => [String(d.employeeId).toUpperCase(), d])
  );
  const byEmail = new Map(
    docs.filter((d) => d.email).map((d) => [String(d.email).toLowerCase(), d])
  );
  const byName = new Map();
  for (const d of docs) {
    if (!d.name) continue;
    const k = String(d.name).toLowerCase().trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(d);
  }
  return { byInternalId, byEmployeeId, byEmail, byName };
}

export function _planTeamMutations(existingEmpIdSet, memberRows) {
  const toInsert = [];
  const duplicates = [];
  const skipped = [];

  for (const row of memberRows) {
    if (!row.matched) {
      skipped.push({ row, reason: row.skipReason || 'employee_not_found' });
      continue;
    }
    const verdict = isIgnoredEmployee(row.matched);
    if (verdict.ignored) {
      skipped.push({ row, reason: verdict.reason });
      continue;
    }
    const empIdKey = String(row.matched._id);
    if (existingEmpIdSet.has(empIdKey)) {
      duplicates.push({ row, employeeId: empIdKey, reason: 'already_in_team' });
      continue;
    }
    toInsert.push({
      employeeId: row.matched._id,
      seniority: row.teamSeniority || 'Member',
    });
    existingEmpIdSet.add(empIdKey);
  }
  return { toInsert, duplicates, skipped };
}

export async function upsertOneTeam({ teamName, meta, memberRows, currentUserId, teamLeadEmployeeId }) {
  const session = await mongoose.startSession();
  let result;
  await session.withTransaction(async () => {
    const setOnInsert = { createdBy: currentUserId, source: 'excel-import' };
    const setFields = {};
    if (meta.department)  setFields.department  = meta.department;
    if (meta.description) setFields.description = meta.description;
    if (teamLeadEmployeeId) setFields.teamLead = teamLeadEmployeeId;

    const before = await Team.findOne({ name: teamName })
      .collation({ locale: 'en', strength: 2 }).session(session);
    const team = await Team.findOneAndUpdate(
      { name: teamName },
      { $setOnInsert: setOnInsert, ...(Object.keys(setFields).length ? { $set: setFields } : {}) },
      { upsert: true, new: true, setDefaultsOnInsert: true, session,
        collation: { locale: 'en', strength: 2 } }
    );
    const isNewTeam = !before;

    const existing = await TeamMember.find({ teamId: team._id })
      .select('employeeId').session(session).lean();
    const existingEmpIds = new Set(existing.map((m) => String(m.employeeId)).filter(Boolean));

    const plan = _planTeamMutations(existingEmpIds, memberRows);
    if (plan.toInsert.length) {
      try {
        await TeamMember.insertMany(
          plan.toInsert.map((p) => ({
            teamId: team._id, createdBy: currentUserId,
            employeeId: p.employeeId, seniority: p.seniority,
            assignmentMode: 'excel-import',
          })),
          { session, ordered: false }
        );
      } catch (e) {
        // Race-tolerant: a concurrent import may have inserted the same
        // (teamId, employeeId) pair. E11000 duplicates are converted to
        // duplicatesSkipped counts; other write errors propagate.
        const writeErrors = e?.writeErrors || (e?.code === 11000 ? [e] : []);
        const dupKeys = new Set(
          writeErrors.filter((w) => (w.code || w.err?.code) === 11000)
            .map((w) => String(w.err?.op?.employeeId || w.op?.employeeId))
        );
        if (!dupKeys.size) throw e;
        plan.toInsert = plan.toInsert.filter((p) => !dupKeys.has(String(p.employeeId)));
        for (const empId of dupKeys) {
          plan.duplicates.push({ employeeId: empId, reason: 'already_in_team' });
        }
      }
    }
    result = { team, isNewTeam, plan };
  });
  session.endSession();
  return result;
}

export function _emptySummary() {
  return {
    teamsCreated: 0, teamsUpdated: 0, employeesAdded: 0,
    employeesIgnored: 0, duplicatesSkipped: 0, ambiguousNames: 0,
    teamLeadSkipped: 0, metadataConflicts: 0, rowsProcessed: 0,
    details: { skipped: [], duplicates: [], metadataConflicts: [], teamLeadSkipped: [], warnings: [] },
    skipReasonCounts: {},
    _created: [], _updated: [],
  };
}

export function _mergeTeamResult(s, { team, isNewTeam, plan, metadataConflicts = [], teamLeadSkipped = null }) {
  if (isNewTeam) {
    s.teamsCreated++;
    s._created.push({ name: team.name, members: plan.toInsert.length });
  } else {
    s.teamsUpdated++;
    s._updated.push({ name: team.name, newMembers: plan.toInsert.length });
  }
  s.employeesAdded += plan.toInsert.length;

  for (const d of plan.duplicates) {
    s.duplicatesSkipped++;
    s.details.duplicates.push({ team: team.name, employeeId: d.employeeId, reason: 'already_in_team' });
  }
  for (const sk of plan.skipped) {
    s.skipReasonCounts[sk.reason] = (s.skipReasonCounts[sk.reason] || 0) + 1;
    if (sk.reason === 'ambiguous_employee_name') s.ambiguousNames++;
    else s.employeesIgnored++;
    s.details.skipped.push({
      team: team.name,
      identifier: sk.row.employeeEmail || sk.row.employeeId || sk.row.employeeName || sk.row.employeeInternalId,
      reason: sk.reason,
      ...(sk.matchCount ? { matchCount: sk.matchCount } : {}),
    });
  }
  for (const mc of metadataConflicts) {
    s.metadataConflicts++;
    s.details.metadataConflicts.push({ team: team.name, field: mc.field, kept: mc.kept, ignored: [mc.ignored] });
  }
  if (teamLeadSkipped) {
    s.teamLeadSkipped++;
    s.details.teamLeadSkipped.push({ team: team.name, ...teamLeadSkipped });
  }
}

export async function runImport({ buffer, fileName, fileSize, currentUserId }) {
  const startedAt = Date.now();
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  const { rows } = parseWorkbook(buffer);
  const { teams: grouped, warnings: parseWarnings } = normalizeRows(rows);

  const summary = _emptySummary();
  summary.rowsProcessed = rows.length;

  const priorImport = await TeamImportLog.findOne({ fileHash })
    .sort({ createdAt: -1 }).select('createdAt').lean();
  if (priorImport) {
    summary.details.warnings.push({
      type: 'duplicate_file_hash',
      previousImportAt: priorImport.createdAt.toISOString(),
    });
  }
  if (parseWarnings.unknownColumns.length) {
    summary.details.warnings.push({
      type: 'unknown_columns', columns: parseWarnings.unknownColumns,
    });
  }

  const allMemberRows = [];
  for (const [, t] of grouped) for (const r of t.memberRows) allMemberRows.push(r);
  const leadEmails = [...grouped.values()].map((t) => t.meta.teamLeadEmail).filter(Boolean);
  const leadAsRows = leadEmails.map((email) => ({ employeeEmail: email }));

  const lookups = await buildEmployeeLookups([...allMemberRows, ...leadAsRows]);
  const resolved = resolveEmployeesFromRows(allMemberRows, lookups);

  let idx = 0;
  for (const t of grouped.values()) {
    t.resolvedMemberRows = [];
    for (let i = 0; i < t.memberRows.length; i++, idx++) t.resolvedMemberRows.push(resolved[idx]);
  }

  for (const [, t] of grouped) {
    let teamLeadEmployeeId = null;
    let teamLeadSkippedInfo = null;
    if (t.meta.teamLeadEmail) {
      const leadMatch = lookups.byEmail.get(t.meta.teamLeadEmail);
      const verdict = leadMatch ? isIgnoredEmployee(leadMatch) : { ignored: true, reason: 'employee_not_found' };
      if (leadMatch && !verdict.ignored) teamLeadEmployeeId = leadMatch._id;
      else teamLeadSkippedInfo = { providedLeadEmail: t.meta.teamLeadEmail, reason: verdict.reason };
    }
    const { team, isNewTeam, plan } = await upsertOneTeam({
      teamName: t.teamName,
      meta: t.meta,
      memberRows: t.resolvedMemberRows,
      currentUserId,
      teamLeadEmployeeId,
    });
    _mergeTeamResult(summary, {
      team, isNewTeam, plan,
      metadataConflicts: t.metadataConflicts,
      teamLeadSkipped: teamLeadSkippedInfo,
    });
  }

  const log = await TeamImportLog.create({
    uploadedBy: currentUserId,
    fileName, fileSize, fileHash,
    rowsProcessed: summary.rowsProcessed,
    teamsCreated: summary.teamsCreated, teamsUpdated: summary.teamsUpdated,
    employeesAdded: summary.employeesAdded, employeesIgnored: summary.employeesIgnored,
    duplicatesSkipped: summary.duplicatesSkipped, ambiguousNames: summary.ambiguousNames,
    teamLeadSkipped: summary.teamLeadSkipped, metadataConflicts: summary.metadataConflicts,
    skipReasonCounts: summary.skipReasonCounts,
  });

  const sumBuf = buildSummaryWorkbookBuffer({
    summary,
    fileMeta: {
      fileName,
      uploadedBy: String(currentUserId),
      uploadedAt: new Date().toISOString(),
      fileHash,
    },
  });
  const summaryFileKey = `team-imports/${new Date().toISOString().slice(0, 10)}/${log._id}-summary.xlsx`;

  let summaryFileUrl;
  let summaryUploadFailed = false;
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.aws.bucketName,
        Key: summaryFileKey,
        Body: sumBuf,
        ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    );
    summaryFileUrl = await generatePresignedDownloadUrl(summaryFileKey, 7 * 24 * 3600);
    await TeamImportLog.updateOne({ _id: log._id }, { $set: { summaryFileKey } });
  } catch (e) {
    summaryUploadFailed = true;
    summary.details.warnings.push({
      type: 'summary_upload_failed',
      message: String(e?.message || e),
    });
    logger.warn(`teams.import: summary upload failed for log ${log._id}: ${e?.message}`);
  }

  logger.info(JSON.stringify(_buildImportMetric({
    importLogId: String(log._id), uploadedBy: currentUserId, startedAt,
    summary, transactionRollbacks: 0, summaryUploadFailed,
    fileMeta: { size: fileSize, hash: fileHash },
  })));

  return { summary, importLogId: String(log._id), summaryFileUrl, summaryUploadFailed };
}

/**
 * Build an in-memory .xlsx workbook summarising a team-import run.
 *
 * Sheets:
 *  - Overview: file metadata + headline counters
 *  - Created:  one row per newly-created team
 *  - Updated:  one row per existing team that gained members
 *  - Skipped:  one row per skipped member (reason + identifier)
 *
 * Pure function — no I/O. Used by `runImport` to produce the buffer that is
 * then uploaded to S3 with a try/catch fallback (upload failure does NOT
 * fail the import; a warning is appended to `summary.details.warnings`).
 *
 * @param {{ summary: object, fileMeta: { fileName: string, uploadedBy: string, uploadedAt: string, fileHash: string } }} args
 * @returns {Buffer}
 */
export function buildSummaryWorkbookBuffer({ summary, fileMeta }) {
  const wb = XLSX.utils.book_new();
  const overview = XLSX.utils.aoa_to_sheet([
    ['Field', 'Value'],
    ['Uploaded By', fileMeta.uploadedBy], ['Uploaded At', fileMeta.uploadedAt],
    ['File Name', fileMeta.fileName], ['File Hash', fileMeta.fileHash],
    ['Rows Processed', summary.rowsProcessed],
    ['Teams Created', summary.teamsCreated], ['Teams Updated', summary.teamsUpdated],
    ['Employees Added', summary.employeesAdded], ['Employees Ignored', summary.employeesIgnored],
    ['Duplicates Skipped', summary.duplicatesSkipped], ['Ambiguous Names', summary.ambiguousNames],
    ['Team Lead Skipped', summary.teamLeadSkipped], ['Metadata Conflicts', summary.metadataConflicts],
  ]);
  XLSX.utils.book_append_sheet(wb, overview, 'Overview');

  const created = XLSX.utils.json_to_sheet(summary._created || []);
  XLSX.utils.book_append_sheet(wb, created, 'Created');

  const updated = XLSX.utils.json_to_sheet(summary._updated || []);
  XLSX.utils.book_append_sheet(wb, updated, 'Updated');

  const skipped = XLSX.utils.json_to_sheet(
    (summary.details.skipped || []).map((s, i) => ({
      Row: i + 1,
      Team: s.team,
      Identifier: s.identifier,
      Reason: s.reason,
      Detail: s.matchCount ? `matched ${s.matchCount} candidates` : '',
    }))
  );
  XLSX.utils.book_append_sheet(wb, skipped, 'Skipped');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function _defangCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

export function buildExportWorkbookBuffer({ teams, membersByTeam, activeCount }) {
  const headers = [
    'Team Name', 'Team Lead Name', 'Team Lead Email', 'Department', 'Description',
    'Employee Internal ID', 'Employee ID', 'Employee Email', 'Employee Name',
    'Team Seniority', 'Active', 'Source', 'Joined',
  ];
  const aoa = [[`Active Member Count: ${activeCount}`], [], headers];
  for (const t of teams) {
    const members = membersByTeam[t.name] || [];
    for (const m of members) {
      const e = m.employeeId || {};
      aoa.push([
        t.name,
        t.teamLead?.name || '',
        t.teamLead?.email || '',
        t.department || '',
        t.description || '',
        String(e._id || ''),
        e.employeeId || '',
        e.email || '',
        e.name || '',
        m.seniority || 'Member',
        e.isActive ? 'Yes' : 'No',
        m.assignmentMode || 'manual',
        m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : '',
      ].map(_defangCell));
    }
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Teams');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function runExport({ filter = {}, includeInactive = false }) {
  const startedAt = Date.now();
  const teams = await Team.find(filter).populate('teamLead', 'name email').lean();
  const membersByTeam = {};
  let activeCount = 0;
  let membersExported = 0;
  for (const t of teams) {
    const members = await TeamMember.find({ teamId: t._id })
      .populate('employeeId', '_id employeeId name email isActive').lean();
    const filtered = includeInactive ? members : members.filter((m) => m.employeeId?.isActive);
    activeCount += filtered.length;
    membersExported += filtered.length;
    membersByTeam[t.name] = filtered;
  }
  const teamsExported = teams.length;

  logger.info(JSON.stringify(_buildExportMetric({
    startedAt, teamsExported, membersExported, includeInactive,
  })));

  return buildExportWorkbookBuffer({ teams, membersByTeam, activeCount });
}

/**
 * Build an in-memory .xlsx workbook that serves as the canonical import
 * template for the Teams bulk-import flow. Contains the header row plus
 * two example rows demonstrating team-lead row + member row shape.
 *
 * Pure function — no I/O. Served by the GET /v1/teams/import-template route.
 *
 * @returns {Buffer}
 */
export function buildTemplateWorkbookBuffer() {
  const aoa = [
    ['Team Name', 'Team Lead Email', 'Department', 'Description',
     'Employee Internal ID', 'Employee ID', 'Employee Email', 'Employee Name', 'Team Seniority'],
    ['Alpha Team', 'lead@dharwin.com', 'Engineering', 'Core platform squad',
     '', 'DBS101', 'asha@dharwin.com', '', 'Lead'],
    ['Alpha Team', '', '', '',
     '', 'DBS102', 'bharat@dharwin.com', '', 'Member'],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Teams');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function _buildImportMetric({ importLogId, uploadedBy, startedAt, summary, transactionRollbacks, summaryUploadFailed, fileMeta }) {
  const rows = Math.max(1, summary.rowsProcessed);
  return {
    event: 'teams.import.completed',
    importLogId,
    uploadedBy: String(uploadedBy),
    durationMs: Date.now() - startedAt,
    rowsProcessed:     summary.rowsProcessed,
    teamsCreated:      summary.teamsCreated,
    teamsUpdated:      summary.teamsUpdated,
    employeesAdded:    summary.employeesAdded,
    employeesIgnored:  summary.employeesIgnored,
    duplicatesSkipped: summary.duplicatesSkipped,
    ambiguousNames:    summary.ambiguousNames,
    metadataConflicts: summary.metadataConflicts,
    transactionRollbacks: transactionRollbacks || 0,
    summaryUploadFailed: !!summaryUploadFailed,
    skippedRatio:   Number((summary.employeesIgnored / rows).toFixed(3)),
    duplicateRatio: Number((summary.duplicatesSkipped / rows).toFixed(3)),
    fileSize: fileMeta?.size, fileHash: fileMeta?.hash,
  };
}

export function _buildExportMetric({ startedAt, teamsExported, membersExported, includeInactive }) {
  return {
    event: 'teams.export.completed',
    durationMs: Date.now() - startedAt,
    teamsExported, membersExported, includeInactive: !!includeInactive,
  };
}
