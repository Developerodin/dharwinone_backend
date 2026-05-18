import XLSX from 'xlsx';
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import Team from '../models/teamGroup.model.js';
import TeamMember from '../models/team.model.js';
import { isIgnoredEmployee } from '../utils/teamImportPatterns.js';

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
