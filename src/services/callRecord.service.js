import httpStatus from 'http-status';
import mongoose from 'mongoose';
import CallRecord, { TERMINAL_STATUSES, rankOf, isTerminal } from '../models/callRecord.model.js';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import config from '../config/config.js';
import { normalizePhone } from '../utils/phone.js';
import { CALL_SOURCES, UI_CALL_SOURCES, classifyCallSource } from '../utils/callSource.js';
import { deriveCallInsights } from '../utils/candidateExtraction.js';
import ApiError from '../utils/ApiError.js';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

/** ObjectId or null — never a raw string (see the createdBy note in upsertDialerCallRecord). */
function toObjectIdOrNull(value) {
  const s = String(value ?? '');
  return /^[a-f0-9]{24}$/i.test(s) ? new mongoose.Types.ObjectId(s) : null;
}

/** Outbound telephony only: fromPhoneNumber → CompanyPhoneNumber.assignedTo. */
async function resolveDialerCreatedByFromCompanyNumber(fromPhoneNumber) {
  try {
    const { resolveUserIdForAssignedCallerId } = await import('./companyPhoneNumber.service.js');
    return toObjectIdOrNull(await resolveUserIdForAssignedCallerId(fromPhoneNumber));
  } catch {
    return null;
  }
}

/** Avoid mixing applicant names into job-post rows when Bolna user_data is stale or shared-agent polluted. */
function businessNameFromBolnaUserData(userData, purposeLower) {
  if (!userData || typeof userData !== 'object') return null;
  const ud = userData;
  const p = purposeLower || '';
  if (p.includes('job_posting_verification') || p.includes('job_verification') || p.includes('recruiter')) {
    if (ud.organisation_name != null && String(ud.organisation_name).trim()) return String(ud.organisation_name).trim();
    if (ud.listing_employer_name != null && String(ud.listing_employer_name).trim()) {
      return String(ud.listing_employer_name).trim();
    }
    if (ud.organisation != null && String(ud.organisation).trim()) return String(ud.organisation).trim();
    if (ud.name != null && String(ud.name).trim()) return String(ud.name).trim();
    return null;
  }
  if (p.includes('job_application') || p.includes('application_verification')) {
    if (ud.candidate_name != null && String(ud.candidate_name).trim()) return String(ud.candidate_name).trim();
    if (ud.name != null && String(ud.name).trim()) return String(ud.name).trim();
    if (ud.organisation != null && String(ud.organisation).trim()) return String(ud.organisation).trim();
    return null;
  }
  if (ud.organisation != null && String(ud.organisation).trim()) return String(ud.organisation).trim();
  if (ud.name != null && String(ud.name).trim()) return String(ud.name).trim();
  if (ud.candidate_name != null && String(ud.candidate_name).trim()) return String(ud.candidate_name).trim();
  return null;
}

function normalizeStatus(status) {
  if (!status) return 'unknown';
  const s = String(status).toLowerCase().trim();
  const statusMap = {
    done: 'completed',
    finished: 'completed',
    ended: 'completed',
    success: 'completed',
    error: 'failed',
    errored: 'failed',
    stopped: 'failed',
    initiate: 'initiated',
    initiated: 'initiated',
    'no-answer': 'no_answer',
    'call-disconnected': 'call_disconnected',
    'in-progress': 'in_progress',
    'balance-low': 'failed',
    queued: 'initiated',
    // Keep ringing distinct so unanswered inbound dialer calls are not shown as live.
    ringing: 'ringing',
    // Twilio DialCallStatus / caller hang-up before answer.
    canceled: 'no_answer',
    cancelled: 'no_answer',
  };
  return statusMap[s] || s;
}

/** Twilio browser dialer rows — keyed by CallSid, not Bolna execution ids. */
function isTwilioDialerRecord(record) {
  if (!record) return false;
  if (record.telephonyData?.provider === 'twilio') return true;
  return /^CA[a-f0-9]{32}$/i.test(String(record.executionId || ''));
}

/**
 * Mongo filter for dialer-placed (browser/bridge) calls. Excludes Bolna/AI
 * verification rows while matching Twilio and Plivo softphone/bridge records.
 */
export const DIALER_CALL_FILTER = {
  $or: [
    { 'telephonyData.provider': { $in: ['twilio', 'plivo'] } },
    { source: { $in: ['initiate', 'backfill'] } },
  ],
};

const TWILIO_DEDUPE_BUCKET_MS = 2 * 60 * 1000;

function twilioDialerGroupKey(record) {
  const to = normalizePhone(record.toPhoneNumber || record.recipientPhoneNumber || record.phone || '') || '';
  const from = normalizePhone(record.fromPhoneNumber || record.userNumber || '') || '';
  const t = record.createdAt ? new Date(record.createdAt).getTime() : 0;
  const bucket = Number.isFinite(t) ? Math.floor(t / TWILIO_DEDUPE_BUCKET_MS) : 0;
  // ponytail: no createdBy in the key — the orphaned PSTN child leg of a
  // browser-dialer call always lands with createdBy null (its own To/From
  // aren't resolvable to an owner), so keying on it split one physical call
  // into two rows that never merged. to/from/bucket alone identifies "same
  // call" since this only groups already-Twilio-dialer-shaped rows.
  return `${to}|${from}|${bucket}`;
}

function scoreTwilioDialerRow(record) {
  let s = 0;
  if (record.status === 'completed') s += 200;
  if (record.status === 'expired') s -= 100;
  if (record.recordingArchive?.twilio?.key) s += 50;
  if (record.duration != null && Number(record.duration) > 0) s += Math.min(Number(record.duration), 3600);
  return s;
}

function mergeTwilioDialerRows(primary, secondary) {
  const a = scoreTwilioDialerRow(primary) >= scoreTwilioDialerRow(secondary) ? primary : secondary;
  const b = a === primary ? secondary : primary;
  const merged = { ...a };
  if (!merged.recordingArchive?.twilio?.key && b.recordingArchive?.twilio?.key) {
    merged.recordingArchive = { ...(merged.recordingArchive || {}), twilio: b.recordingArchive.twilio };
  }
  if (merged.status === 'expired' && b.status === 'completed') {
    merged.status = 'completed';
    merged.statusRank = 10;
  }
  const durA = Number(merged.duration) || 0;
  const durB = Number(b.duration) || 0;
  if (durB > durA) merged.duration = b.duration;
  if (!merged.recordingUrl && b.recordingUrl) merged.recordingUrl = b.recordingUrl;
  if (!merged.recordingArchivedAt && b.recordingArchivedAt) merged.recordingArchivedAt = b.recordingArchivedAt;
  // The orphaned child leg has createdBy null; backfill from whichever leg has it
  // so the merged row still resolves an owner for the dialer Recent filter.
  if (!merged.createdBy && b.createdBy) merged.createdBy = b.createdBy;
  return merged;
}

function dedupeTwilioDialerRows(rows) {
  const twilio = [];
  const other = [];
  for (const r of rows) {
    if (isTwilioDialerRecord(r)) twilio.push(r);
    else other.push(r);
  }
  if (twilio.length <= 1) return rows;

  const byKey = new Map();
  for (const r of twilio) {
    const key = twilioDialerGroupKey(r);
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeTwilioDialerRows(prev, r) : r);
  }
  const dedupedTwilio = [...byKey.values()];
  const merged = [...other, ...dedupedTwilio];
  merged.sort((x, y) => {
    const tx = x.createdAt ? new Date(x.createdAt).getTime() : 0;
    const ty = y.createdAt ? new Date(y.createdAt).getTime() : 0;
    return ty - tx;
  });
  return merged;
}

/**
 * Merge duplicate Twilio dialer rows in Mongo (parent leg + PSTN child leg).
 * Keeps the best row per to/from/agent/time bucket; deletes orphans.
 */
async function consolidateTwilioDialerDuplicates({ limit = 100 } = {}) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await CallRecord.find({
    createdAt: { $gte: since },
    $or: [
      { 'telephonyData.provider': 'twilio' },
      { executionId: { $regex: '^CA[a-f0-9]{32}$', $options: 'i' } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit * 4, 400))
    .lean();

  const groups = new Map();
  for (const r of rows) {
    const key = twilioDialerGroupKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let groupsMerged = 0;
  let deleted = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let keeper = group.reduce((best, cur) => (scoreTwilioDialerRow(cur) > scoreTwilioDialerRow(best) ? cur : best));
    for (const row of group) {
      if (String(row._id) === String(keeper._id)) continue;
      const merged = mergeTwilioDialerRows(keeper, row);
      const $set = {};
      if (merged.recordingArchive?.twilio?.key && !keeper.recordingArchive?.twilio?.key) {
        $set['recordingArchive.twilio'] = merged.recordingArchive.twilio;
        $set.recordingArchivedAt = merged.recordingArchivedAt || new Date();
      }
      if (merged.status === 'completed' && keeper.status === 'expired') {
        $set.status = 'completed';
        $set.statusRank = 10;
        $set.statusUpdatedAt = new Date();
        $set.completedAt = keeper.completedAt || new Date();
        $set.errorMessage = null;
      }
      if ((Number(merged.duration) || 0) > (Number(keeper.duration) || 0)) {
        $set.duration = merged.duration;
      }
      if (!keeper.createdBy && merged.createdBy) {
        $set.createdBy = merged.createdBy;
      }
      if (Object.keys($set).length) {
        await CallRecord.updateOne({ _id: keeper._id }, { $set });
        keeper = { ...keeper, ...$set, recordingArchive: { ...keeper.recordingArchive, ...merged.recordingArchive } };
      }
      await CallRecord.deleteOne({ _id: row._id });
      deleted += 1;
    }
    groupsMerged += 1;
  }
  return { groupsMerged, deleted };
}

function normalizePayload(payload) {
  const executionId = payload.id ?? payload.execution_id ?? payload.executionId;
  const data = payload.data || payload.execution || payload;
  const rawStatus = payload.status ?? payload.smart_status ?? data.status ?? data.smart_status ?? 'unknown';
  const status = normalizeStatus(rawStatus);

  const transcript =
    payload.transcript ??
    payload.transcription ??
    payload.conversation_transcript ??
    data.transcript ??
    data.transcription ??
    data.conversation_transcript ??
    '';
  const telephony = payload.telephony_data ?? data.telephony_data ?? {};
  const toPhone =
    payload.recipient_phone_number ??
    data.recipient_phone_number ??
    payload.user_number ??
    data.user_number ??
    telephony.to_number ??
    telephony.recipient_phone_number;
  const fromPhone =
    telephony.from_number ??
    payload.agent_number ??
    data.telephony_data?.from_number ??
    data.agent_number;

  const duration =
    payload.duration ??
    payload.conversation_time ??
    payload.conversation_duration ??
    data.duration ??
    data.conversation_time ??
    telephony.duration ??
    telephony.conversation_duration;
  const durationNum = duration != null ? parseInt(duration, 10) : undefined;
  const recordingUrl = telephony.recording_url ?? payload.recording_url ?? data.recording_url;

  const userData = payload.user_data ?? data.user_data ?? {};
  const purpose = payload.purpose ?? data.purpose;
  const purposeLower = String(purpose || '').toLowerCase();
  const businessName =
    businessNameFromBolnaUserData(userData, purposeLower) ||
    payload.business_name ||
    data.business_name ||
    payload.candidate_name ||
    data.candidate_name;
  const language = payload.language ?? data.language ?? userData.language ?? null;
  const agentId = payload.agent_id ?? data.agent_id ?? payload.agentId ?? data.agentId;

  return {
    executionId: executionId ? String(executionId) : undefined,
    status,
    phone: toPhone ? String(toPhone) : undefined,
    recipientPhoneNumber: toPhone ? String(toPhone) : undefined,
    toPhoneNumber: toPhone ? String(toPhone) : undefined,
    userNumber: fromPhone ? String(fromPhone) : undefined,
    fromPhoneNumber: fromPhone ? String(fromPhone) : undefined,
    businessName: businessName ? String(businessName).trim() : undefined,
    language: language ? String(language).trim() : undefined,
    transcript: transcript || undefined,
    conversationTranscript: payload.conversation_transcript ?? data.conversation_transcript,
    duration: !Number.isNaN(durationNum) ? durationNum : undefined,
    recordingUrl: recordingUrl || undefined,
    agentId: agentId ? String(agentId).trim() : undefined,
    purpose: purpose ? String(purpose).trim() : undefined,
    extractedData: payload.extracted_data ?? data.extracted_data,
    telephonyData: Object.keys(telephony).length ? telephony : undefined,
    raw: payload,
  };
}

/**
 * Legacy webhook fallback. Now strictly executionId-gated — payloads without
 * a Bolna executionId are dropped instead of persisted as null-id ghosts.
 * The active path is callSyncService.applyEvent; this remains only for any
 * external integration still pointing here.
 */
async function createFromWebhook(payload) {
  const doc = normalizePayload(payload);
  if (!doc.executionId) {
    // Pre-fix: this branch created a row with executionId=null — the original
    // ghost-call factory. Reject loudly instead.
    return null;
  }
  const existing = await CallRecord.findOne({ executionId: doc.executionId }).lean();
  if (existing) {
    const update = { ...doc };
    delete update.raw;
    const updated = await CallRecord.findOneAndUpdate(
      { executionId: doc.executionId },
      { $set: update, $setOnInsert: { raw: doc.raw || {} } },
      { new: true }
    ).lean();
    return updated;
  }
  // Tag provenance so the cleanup cron can age it out if it never matches a
  // verified Bolna execution.
  const record = await CallRecord.create({
    ...doc,
    source: 'webhook',
    bolnaVerifiedAt: null,
  });
  return record;
}

/**
 * Records a non-admin may see: calls they placed (createdBy), calls on jobs they
 * created, or calls on candidates they own. Shared by listCallRecords and the
 * per-contact reverse lookup so scoping stays in one place.
 */
export async function nonAdminCallScope(userId) {
  const [jobIds, candidateIds] = await Promise.all([
    Job.distinct('_id', { createdBy: userId }),
    Employee.distinct('_id', { owner: userId }),
  ]);
  return {
    $or: [
      { job: { $in: jobIds } },
      { candidate: { $in: candidateIds } },
      { createdBy: userId },
    ],
  };
}

function composeMongoFilter(parts) {
  if (!parts.length) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

function flattenMongoFilter(filter) {
  if (!filter || Object.keys(filter).length === 0) return [];
  if (filter.$and) return filter.$and;
  return [filter];
}

/**
 * Dialer Recent: load rows attributed to the user plus orphan PSTN child legs
 * that share the same Twilio dedupe bucket (to/from/time). Child legs are
 * createdBy:null and would be dropped by a naive createdBy filter, so Call
 * Records (admin) could show the merged ringing leg while Recent only saw the
 * stale parent — or missed the call entirely when dedupe preferred the child.
 */
async function fetchDialerChannelCallRows({ dialerScopeFilter, userId, sort, fetchCap }) {
  const scopeParts = flattenMongoFilter(dialerScopeFilter);
  const userOid = toObjectIdOrNull(userId);
  const ownedRows = await CallRecord.find(
    composeMongoFilter([...scopeParts, { createdBy: userOid || userId }])
  )
    .sort(sort)
    .limit(fetchCap)
    .lean();

  const familyKeys = new Set();
  let windowStart = null;
  let windowEnd = null;
  for (const row of ownedRows) {
    if (!isTwilioDialerRecord(row)) continue;
    const key = twilioDialerGroupKey(row);
    if (familyKeys.has(key)) continue;
    familyKeys.add(key);
    const t = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    if (!Number.isFinite(t)) continue;
    const bucket = Math.floor(t / TWILIO_DEDUPE_BUCKET_MS);
    const start = bucket * TWILIO_DEDUPE_BUCKET_MS;
    const end = (bucket + 1) * TWILIO_DEDUPE_BUCKET_MS;
    if (windowStart == null || start < windowStart) windowStart = start;
    if (windowEnd == null || end > windowEnd) windowEnd = end;
  }

  let familyRows = [];
  if (familyKeys.size > 0 && windowStart != null && windowEnd != null) {
    const orphanCandidates = await CallRecord.find(
      composeMongoFilter([
        ...scopeParts,
        { createdBy: null },
        { createdAt: { $gte: new Date(windowStart), $lt: new Date(windowEnd) } },
      ])
    )
      .sort(sort)
      .limit(fetchCap)
      .lean();
    familyRows = orphanCandidates.filter(
      (row) => isTwilioDialerRecord(row) && familyKeys.has(twilioDialerGroupKey(row))
    );
  }

  const byId = new Map();
  for (const row of [...ownedRows, ...familyRows]) {
    byId.set(String(row._id), row);
  }
  return [...byId.values()];
}

async function listCallRecords(options = {}) {
  const limit = Math.min(Number(options.limit) || 25, 500);
  const page = Number(options.page) || 1;
  const skip = (page - 1) * limit;
  const sortBy = options.sortBy === 'date' || options.sortBy === 'createdAt' ? 'createdAt' : 'createdAt';
  const order = options.order === 'asc' ? 1 : -1;
  const sort = { [sortBy]: order };

  const andConditions = [];
  if (options.search && String(options.search).trim()) {
    const term = String(options.search).trim();
    andConditions.push({
      $or: [
        { phone: new RegExp(term, 'i') },
        { recipientPhoneNumber: new RegExp(term, 'i') },
        { toPhoneNumber: new RegExp(term, 'i') },
        { fromPhoneNumber: new RegExp(term, 'i') },
        { userNumber: new RegExp(term, 'i') },
        { businessName: new RegExp(term, 'i') },
      ],
    });
  }
  if (options.status && String(options.status).trim() && String(options.status).toLowerCase() !== 'all') {
    const statusNorm = String(options.status).trim().toLowerCase().replace(/-/g, '_');
    if (statusNorm === 'missed') {
      // Missed = unanswered only (not explicit declines).
      andConditions.push({
        status: { $in: ['missed', 'no_answer', 'canceled', 'cancelled'] },
      });
    } else if (statusNorm === 'declined') {
      andConditions.push({ status: { $in: ['declined', 'rejected', 'busy'] } });
    } else {
      andConditions.push({ status: String(options.status).trim() });
    }
  }
  if (options.language && String(options.language).trim() && String(options.language).toLowerCase() !== 'all') {
    andConditions.push({ language: String(options.language).trim() });
  }

  // Call-type filter (AI Agent / Telephony / In-App). Orthogonal to ownership —
  // it narrows what a user may already see, it never widens it.
  if (options.callSource && UI_CALL_SOURCES.includes(String(options.callSource))) {
    andConditions.push({ callSource: String(options.callSource) });
  }

  const isDialerChannel = options.channel === 'dialer' && options.userId;
  if (isDialerChannel) {
    // Ownership is enforced after Twilio parent/child dedupe (see fetchDialerChannelCallRows).
    andConditions.push({ candidate: null, job: null });
    andConditions.push(DIALER_CALL_FILTER);
  } else if (!options.isAdmin && options.userId) {
    // Dialer (Twilio) calls have no job/candidate link — nonAdminCallScope also
    // matches createdBy so the agent who placed the call sees it in their records.
    andConditions.push(await nonAdminCallScope(options.userId));
  }

  const filter = andConditions.length === 0 ? {} : andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  let dedupedResults;
  let total;
  if (isDialerChannel) {
    const fetchCap = Math.min(500, Math.max(limit * 10, 200));
    const rawRows = await fetchDialerChannelCallRows({
      dialerScopeFilter: filter,
      userId: options.userId,
      sort,
      fetchCap,
    });
    const owned = dedupeTwilioDialerRows(rawRows).filter(
      (r) => r.createdBy && String(r.createdBy) === String(options.userId)
    );
    total = owned.length;
    dedupedResults = owned.slice(skip, skip + limit);
  } else {
    const [results, count] = await Promise.all([
      CallRecord.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      CallRecord.countDocuments(filter),
    ]);
    dedupedResults = dedupeTwilioDialerRows(results);
    total = count;
  }

  // executionId -> Job (job post verification) or JobApplication (candidate verification)
  const executionIds = dedupedResults.map((r) => String(r.executionId || '')).filter(Boolean);
  const executionIdVariants = [...new Set(executionIds.flatMap((id) => [id, id.trim()]).filter(Boolean))];
  const [jobsWithExecutionId, jobAppsWithExecutionId] = await Promise.all([
    executionIdVariants.length
      ? Job.find({ verificationCallExecutionId: { $in: executionIdVariants } })
          .select('verificationCallExecutionId organisation.name organisation.phone')
          .lean()
      : Promise.resolve([]),
    executionIdVariants.length
      ? (await import('../models/jobApplication.model.js')).default
          .find({ verificationCallExecutionId: { $in: executionIdVariants } })
          .select('verificationCallExecutionId candidate')
          .populate('candidate', 'fullName')
          .lean()
      : Promise.resolve([]),
  ]);
  const executionIdToJob = new Map(
    jobsWithExecutionId.map((j) => [normalizeKey(j.verificationCallExecutionId), j])
  );
  const executionIdToJobApp = new Set(
    jobAppsWithExecutionId.map((a) => normalizeKey(a.verificationCallExecutionId))
  );
  const executionIdToCandidateName = new Map(
    jobAppsWithExecutionId
      .filter((a) => a.verificationCallExecutionId && a.candidate?.fullName)
      .map((a) => [normalizeKey(a.verificationCallExecutionId), String(a.candidate.fullName).trim()])
  );
  const executionIdToJobAppSet = executionIdToJobApp;

  const jobOrgPhones = new Map();
  const allJobsWithPhone = await Job.find({ 'organisation.phone': { $exists: true, $nin: [null, ''] } })
    .select('organisation.name organisation.phone')
    .limit(2000)
    .lean();
  for (const j of allJobsWithPhone) {
    const p = j.organisation?.phone;
    if (p && j.organisation?.name) {
      const norm = normalizePhone(p);
      if (norm) jobOrgPhones.set(norm, j.organisation.name.trim());
    }
  }

  const toPhoneMatchesJobOrg = new Set();
  for (const r of dedupedResults) {
    const execId = normalizeKey(r.executionId);
    if (executionIdToJob.has(execId)) {
      toPhoneMatchesJobOrg.add(r._id?.toString());
      const job = executionIdToJob.get(execId);
      if (job?.organisation?.name) {
        r.businessName = job.organisation.name.trim();
      }
    } else if (executionIdToJobAppSet.has(execId)) {
      const candName = executionIdToCandidateName.get(execId);
      if (candName) {
        r.businessName = candName;
      }
    } else {
      const toPhone = r.toPhoneNumber || r.recipientPhoneNumber || r.phone;
      if (toPhone) {
        const normalized = normalizePhone(toPhone);
        let matchedOrgName = normalized ? jobOrgPhones.get(normalized) : null;
        if (!matchedOrgName && normalized) {
          const digits = normalized.replace(/\D/g, '');
          const last10 = digits.length >= 10 ? digits.slice(-10) : null;
          for (const [orgNorm, name] of jobOrgPhones) {
            const orgDigits = orgNorm.replace(/\D/g, '');
            if (last10 && orgDigits.slice(-10) === last10) {
              matchedOrgName = name;
              break;
            }
          }
        }
        if (matchedOrgName) {
          toPhoneMatchesJobOrg.add(r._id?.toString());
          if (!(r.businessName && r.businessName.trim())) {
            r.businessName = matchedOrgName;
          }
        }
      }
    }
  }

  // Fetch candidate names for records with candidate ref but no businessName
  const needCandidateName = dedupedResults.filter((r) => r.candidate && !(r.businessName && r.businessName.trim()));
  if (needCandidateName.length > 0) {
    const candidateIds = [...new Set(needCandidateName.map((r) => r.candidate?.toString()).filter(Boolean))];
    const candidates = await Employee.find({ _id: { $in: candidateIds } })
      .select('_id fullName')
      .lean();
    const candidateNameMap = new Map(candidates.map((c) => [c._id?.toString(), c.fullName || '']));
    for (const r of needCandidateName) {
      const cid = r.candidate?.toString();
      if (cid && candidateNameMap.has(cid)) {
        r.businessName = candidateNameMap.get(cid) || r.businessName;
      }
    }
  }

  const jobAgentId = normalizeKey(config.bolna?.agentId);
  const candidateAgentId = normalizeKey(config.bolna?.candidateAgentId);
  const useAgentRouting = Boolean(jobAgentId && candidateAgentId && jobAgentId !== candidateAgentId);

  // Add displayCategory and displayName for frontend - use agentId first (each call type has its own agent)
  for (const r of dedupedResults) {
    const purpose = (r.purpose || '').toLowerCase().trim();
    const execId = normalizeKey(r.executionId);
    const aid = normalizeKey(r.agentId || r.raw?.agent_id || r.raw?.agentId);
    const isCandidateByLink = Boolean(r.candidate) || executionIdToJobAppSet.has(execId);
    const isJobByLink = Boolean(r.job) || executionIdToJob.has(execId) || toPhoneMatchesJobOrg.has(r._id?.toString());

    let displayCategory = 'Other';

    if (useAgentRouting && aid === candidateAgentId) {
      displayCategory = 'Student/Candidate';
    } else if (useAgentRouting && aid === jobAgentId) {
      displayCategory = 'Job/Recruiter';
    } else if (
      isCandidateByLink ||
      purpose.includes('job_application_verification') ||
      purpose.includes('application_verification')
    ) {
      displayCategory = 'Student/Candidate';
    } else if (
      isJobByLink ||
      purpose.includes('job_verification') ||
      purpose.includes('job_posting_verification') ||
      purpose.includes('recruiter')
    ) {
      displayCategory = 'Job/Recruiter';
    } else if (
      displayCategory === 'Other' &&
      !purpose.includes('job_application_verification') &&
      !purpose.includes('application_verification') &&
      !isCandidateByLink &&
      Boolean(r.executionId || r.toPhoneNumber || r.recipientPhoneNumber || r.phone)
    ) {
      // Last fallback for legacy recruiter records with sparse metadata.
      displayCategory = 'Job/Recruiter';
    }
    r.displayCategory = displayCategory;
    r.displayName = (r.businessName && r.businessName.trim()) || r.toPhoneNumber || r.recipientPhoneNumber || r.phone || null;
  }

  // Twilio dialer recordings live only in S3 (no public provider URL) — presign
  // a fresh playback URL so the list's recording link works.
  const twilioRecs = dedupedResults.filter((r) => r.recordingArchive?.twilio?.key && !r.recordingUrl);
  if (twilioRecs.length) {
    const { generatePresignedDownloadUrl } = await import('../config/s3.js');
    await Promise.all(
      twilioRecs.map(async (r) => {
        try {
          r.recordingUrl = await generatePresignedDownloadUrl(r.recordingArchive.twilio.key);
        } catch {
          /* leave recordingUrl empty — UI shows "—" */
        }
      })
    );
  }

  const totalPages = Math.ceil(total / limit);
  return { results: dedupedResults, total, totalPages, page, limit };
}

async function updateFromExecutionDetails(executionId, details, options = {}) {
  if (!executionId || !details) return null;

  const payload = {
    ...details,
    id: details.id ?? details.execution_id ?? executionId,
  };
  const norm = normalizePayload(payload);
  const data = payload.data || payload.execution || {};
  const telephony = payload.telephony_data || payload.telephonyData || data.telephony_data || {};
  const userData = payload.user_data ?? data.user_data ?? {};

  const update = {};

  if (norm.transcript && String(norm.transcript).trim()) {
    update.transcript = String(norm.transcript).trim();
  }
  if (norm.conversationTranscript && String(norm.conversationTranscript).trim()) {
    update.conversationTranscript = String(norm.conversationTranscript).trim();
  }
  if (!update.transcript && norm.conversationTranscript && String(norm.conversationTranscript).trim()) {
    update.transcript = String(norm.conversationTranscript).trim();
  }

  if (norm.recordingUrl) update.recordingUrl = norm.recordingUrl;
  if (norm.duration != null && !Number.isNaN(Number(norm.duration))) {
    update.duration = Number(norm.duration);
  }
  if (telephony.duration != null && update.duration == null) {
    const d = parseInt(telephony.duration, 10);
    if (!Number.isNaN(d)) update.duration = d;
  }

  const hadExplicitStatus =
    payload.status != null ||
    payload.smart_status != null ||
    data.status != null ||
    data.smart_status != null;
  if (hadExplicitStatus && norm.status) {
    update.status = norm.status;
  }

  // Monotonic rank guard. Bolna 404s on aged executions and returns
  // status='unknown' (rank 0); without this guard, a completed/failed/etc.
  // (rank 10) row gets clobbered by raw $set, and the cron reconciler then
  // escalates the regressed status to 'expired'. Mirror callSync.applyEvent's
  // contract: never let status walk backward.
  if (update.status) {
    const existingRankRow = await CallRecord.findOne({ executionId: String(executionId) })
      .select('status statusRank')
      .lean();
    if (existingRankRow) {
      const existingRank = existingRankRow.statusRank ?? rankOf(existingRankRow.status);
      const incomingRank = rankOf(update.status);
      const sameRankTerminalEnrichment =
        incomingRank === existingRank && isTerminal(update.status) && isTerminal(existingRankRow.status);
      if (incomingRank < existingRank || (incomingRank === existingRank && !sameRankTerminalEnrichment)) {
        delete update.status;
      } else {
        update.statusRank = incomingRank;
        update.statusUpdatedAt = new Date();
      }
    } else {
      update.statusRank = rankOf(update.status);
      update.statusUpdatedAt = new Date();
    }
  }

  if (norm.fromPhoneNumber) update.fromPhoneNumber = String(norm.fromPhoneNumber);
  if (telephony.from_number && !update.fromPhoneNumber) {
    update.fromPhoneNumber = String(telephony.from_number);
  }

  const existingForPurpose = await CallRecord.findOne({ executionId: String(executionId) })
    .select('purpose')
    .lean();
  const purposeLower = String(existingForPurpose?.purpose || '').toLowerCase();
  const fromUserData = businessNameFromBolnaUserData(userData, purposeLower);
  if (fromUserData) update.businessName = fromUserData;

  const agentId = norm.agentId ?? payload.agent_id ?? payload.agentId ?? data.agent_id ?? data.agentId;
  if (agentId) update.agentId = String(agentId).trim();

  const extracted =
    payload.extracted_data ?? data.extracted_data ?? details.extracted_data;
  if (extracted && typeof extracted === 'object') {
    update.extractedData = extracted;
  }
  // Phase 1: re-derive quality + typed verification on reconcile. Typed fields
  // only when extraction is present, so transcript-only reconciles don't clobber.
  if (extracted || norm.transcript) {
    const insights = deriveCallInsights({
      extractedData: extracted,
      transcript: norm.transcript,
      status: norm.status,
    });
    const now = new Date();
    update.callQuality = { ...insights.callQuality, evaluatedAt: now };
    if (extracted) {
      update.verification = { ...insights.verification, extractedAt: now };
    }
  }

  const errRaw = payload.error_message ?? data.error_message ?? details.error_message;
  if (options.setErrorMessage && errRaw) {
    let msg = errRaw;
    if (typeof msg === 'string') {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && parsed.message) msg = parsed.message;
      } catch {
        /* ignore parse error */
      }
    }
    update.errorMessage = String(msg);
  }

  if (options.setCompletedAt) {
    const statusForEnd = update.status || norm.status;
    const ended = [
      'completed',
      'failed',
      'no_answer',
      'busy',
      'stopped',
      'error',
      'call_disconnected',
      'balance-low',
    ].includes(normalizeStatus(statusForEnd));
    if (ended) {
      const updatedAt = payload.updated_at ?? data.updated_at;
      const initiatedAt = payload.initiated_at ?? data.initiated_at;
      update.completedAt = updatedAt
        ? new Date(updatedAt)
        : initiatedAt
          ? new Date(initiatedAt)
          : new Date();
    }
  }

  if (Object.keys(update).length === 0) {
    return CallRecord.findOne({ executionId: String(executionId) }).lean();
  }
  const record = await CallRecord.findOneAndUpdate(
    { executionId: String(executionId) },
    { $set: update },
    { new: true }
  ).lean();
  return record;
}

/**
 * Seed a call row after initiating a Bolna call (applicant flow). Maps legacy related* keys to schema refs.
 */
async function createRecord(body) {
  if (!body?.executionId) return null;
  const doc = {
    executionId: String(body.executionId),
    recipientPhoneNumber: body.recipientPhone ? String(body.recipientPhone) : undefined,
    toPhoneNumber: body.recipientPhone ? String(body.recipientPhone) : undefined,
    phone: body.recipientPhone ? String(body.recipientPhone) : undefined,
    businessName: body.recipientName ? String(body.recipientName).trim() : undefined,
    purpose: body.purpose ? String(body.purpose).trim() : undefined,
    job: body.relatedJob || undefined,
    candidate: body.relatedCandidate || undefined,
    status: body.status ? normalizeStatus(body.status) : 'initiated',
  };
  const existing = await CallRecord.findOne({ executionId: doc.executionId }).lean();
  if (existing) {
    const rest = { ...doc };
    delete rest.executionId;
    return CallRecord.findOneAndUpdate({ executionId: doc.executionId }, { $set: rest }, { new: true }).lean();
  }
  // Scheduler-seeded inserts come straight from a successful Bolna POST /call,
  // so executionId is already authoritative — tag bolnaVerifiedAt now.
  return CallRecord.create({
    ...doc,
    source: 'initiate',
    bolnaVerifiedAt: new Date(),
  });
}

/**
 * JWT-authed dialer endpoints must not mutate another user's CallRecord.
 * Creates and orphan claims (createdBy null → real user) remain allowed.
 */
async function assertDialerRecordMutationAllowed(executionId, userId) {
  if (!executionId) return;
  const existing = await CallRecord.findOne({ executionId: String(executionId) })
    .select('createdBy')
    .lean();
  if (!existing?.createdBy) return;
  if (!userId || String(existing.createdBy) !== String(userId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You do not have access to this call');
  }
}

/**
 * Upsert a Twilio dialer CallRecord keyed by the Twilio CallSid (executionId).
 * Used by the Twilio voice/status/recording webhooks. createdBy/source are set
 * once on insert; status only moves forward (monotonic rank guard).
 * If an orphan row already exists with createdBy: null, a later webhook that
 * supplies createdBy will claim ownership so the call appears in history.
 */
async function upsertDialerCallRecord({
  executionId,
  createdBy,
  toPhoneNumber,
  fromPhoneNumber,
  status,
  duration,
  provider = 'twilio',
  direction,
  createdAt,
  source = 'initiate',
  businessName,
} = {}) {
  if (!executionId) return null;

  const existing = await CallRecord.findOne({ executionId: String(executionId) })
    .select('status statusRank telephonyData.direction createdBy')
    .lean();

  const effectiveDirection =
    direction ||
    (existing?.telephonyData?.direction === 'inbound' || existing?.telephonyData?.direction === 'outbound'
      ? existing.telephonyData.direction
      : undefined);

  const set = {};
  if (toPhoneNumber) {
    const t = String(toPhoneNumber);
    set.toPhoneNumber = t;
    // Outbound: other party is the destination. Inbound: other party is the caller.
    if (effectiveDirection !== 'inbound') {
      set.recipientPhoneNumber = t;
      set.phone = t;
    } else {
      set.userNumber = t;
    }
  }
  if (fromPhoneNumber) {
    const f = String(fromPhoneNumber);
    set.fromPhoneNumber = f;
    if (effectiveDirection === 'inbound') {
      set.recipientPhoneNumber = f;
      set.phone = f;
    } else {
      set.userNumber = f;
    }
  }
  if (duration != null && !Number.isNaN(Number(duration))) set.duration = Number(duration);
  set['telephonyData.provider'] = provider;
  if (direction) set['telephonyData.direction'] = direction;
  const trimmedBusinessName = businessName != null ? String(businessName).trim() : '';
  if (trimmedBusinessName) {
    set.businessName = { $ifNull: ['$businessName', trimmedBusinessName] };
  }

  if (status) {
    const st = normalizeStatus(status);
    const existingStatus = existing?.status ? String(existing.status).toLowerCase() : '';
    const incomingRank = rankOf(st);
    const existingRank = existing ? existing.statusRank ?? rankOf(existing.status) : -1;

    // Terminal dialer statuses share rank 10. Twilio still sends a parent-leg
    // CallStatus=completed after Dial ends (reject / miss / hangup). Equal-rank
    // events may enrich duration/phones but must not rewrite a saved outcome
    // (e.g. Declined → Incoming). Only a strict rank increase moves status,
    // plus a few unanswered refinements (busy/no_answer → declined).
    let applyStatus = false;
    if (!existingStatus) {
      applyStatus = true;
    } else if (incomingRank > existingRank) {
      applyStatus = true;
    } else if (incomingRank === existingRank) {
      const unanswered = new Set(['declined', 'no_answer', 'busy']);
      // Explicit reject wins over Twilio busy / timeout labels.
      if (
        st === 'declined' &&
        (existingStatus === 'busy' || existingStatus === 'no_answer')
      ) {
        applyStatus = true;
      } else if (unanswered.has(existingStatus)) {
        // Keep Declined / Missed / busy — never clobber with completed etc.
        applyStatus = false;
      }
      // else: leave equal-rank terminal as-is (enrichment-only)
    }

    if (applyStatus) {
      set.status = st;
      set.statusRank = incomingRank;
      set.statusUpdatedAt = new Date();
      if (isTerminal(st)) set.completedAt = new Date();
    }
  }

  // createdBy/source/bolnaVerifiedAt/createdAt are "set once, on whichever request
  // actually establishes the row" fields. Twilio fires multiple webhooks for the
  // same CallSid close together (the Voice-URL seed, which carries the real
  // createdBy, and the dialed child leg's own statusCallback, whose From/To are
  // phone numbers so it can never resolve a user and passes createdBy: null).
  // A plain read-then-write here raced: both requests could read "no existing
  // row", and whichever one physically performed the insert decided createdBy
  // permanently — even a later request with the correct value couldn't reclaim
  // it, because its own `existing` snapshot (read before the race resolved) was
  // already stale. $ifNull is evaluated by the server at the moment this exact
  // atomic operation runs, against the document's real current state, not a
  // client-side snapshot, so it can't lose that race: first write wins for these
  // fields, same as $setOnInsert did for a real single-writer insert, but safe
  // under concurrent upserts too. A later request's OWN createdBy is never lost
  // either way — if it lands second it just doesn't overwrite a real value.
  set.executionId = String(executionId);
  // Pipeline updates bypass mongoose hooks, so the model's pre-save classifier
  // never runs here — classify explicitly. Set-once, except that AI always wins:
  // the first webhook often lacks the caller ID, so a later leg that recognises
  // the configured AI number may upgrade the row, but never downgrade it.
  const dialerCallSource = classifyCallSource({ provider, fromPhoneNumber, executionId });
  set.callSource =
    dialerCallSource === CALL_SOURCES.AI_AGENT
      ? dialerCallSource
      : { $ifNull: ['$callSource', dialerCallSource] };
  let resolvedCreatedBy = toObjectIdOrNull(createdBy);
  if (
    !resolvedCreatedBy &&
    !existing?.createdBy &&
    dialerCallSource === CALL_SOURCES.TELEPHONY &&
    effectiveDirection === 'outbound' &&
    fromPhoneNumber
  ) {
    resolvedCreatedBy = await resolveDialerCreatedByFromCompanyNumber(fromPhoneNumber);
  }
  // Pipeline updates are NOT cast by Mongoose, so a plain `req.user.id` string
  // lands as a BSON string while every list filter casts createdBy to ObjectId
  // (schema type) -- the row then matches nothing and vanishes from the dialer's
  // Recent list. Cast here; anything unusable becomes null (an orphan a later
  // webhook can still claim) rather than a string that can never match.
  set.createdBy = { $ifNull: ['$createdBy', resolvedCreatedBy] };
  set.source = { $ifNull: ['$source', source] };
  const createdAtOverride = createdAt instanceof Date ? createdAt : createdAt ? new Date(createdAt) : null;
  const validCreatedAtOverride = createdAtOverride && !Number.isNaN(createdAtOverride.getTime()) ? createdAtOverride : null;
  set.createdAt = { $ifNull: ['$createdAt', validCreatedAtOverride || '$$NOW'] };
  set.updatedAt = '$$NOW';
  if (provider === 'twilio') {
    // Twilio CallSid rows are never Bolna executions — skip Bolna reconcilers.
    set.bolnaVerifiedAt = { $ifNull: ['$bolnaVerifiedAt', '$$NOW'] };
  }

  return CallRecord.findOneAndUpdate(
    { executionId: String(executionId) },
    [{ $set: set }],
    { new: true, upsert: true }
  )
    .lean()
    .then((record) => {
      // Notify the owning user's call history in real time.
      // Skip duplicate emits when this upsert only enriched phones/duration and
      // did not change status (avoids triple "Call declined" local notifications).
      if (record) {
        // Only push socket updates when status actually moved (or this is the
        // first insert). Enrichment-only upserts were re-emitting the same
        // "declined" row 2–3× and stacking local outcome notifications.
        const statusChanged = Boolean(set.status);
        if (statusChanged || !existing) {
          try {
            // Lazy import avoids circular deps with chatSocket ↔ callRecord.
            import('./chatSocket.service.js')
              .then((mod) => {
                if (typeof mod.emitCallUpdate === 'function') mod.emitCallUpdate(record);
              })
              .catch(() => undefined);
          } catch {
            // ignore
          }
        }
      }
      return record;
    });
}

async function updateCallRecordByExecutionId(executionId, updateData, options = {}) {
  if (!executionId || !updateData || Object.keys(updateData).length === 0) return null;
  const record = await CallRecord.findOneAndUpdate(
    { executionId: String(executionId) },
    { $set: updateData, $setOnInsert: { executionId: String(executionId) } },
    { new: true, upsert: Boolean(options.upsert) }
  ).lean();
  return record;
}

/**
 * Update agent-supplied annotations on a call (Batch B): notes, tags, relatedTo.
 * Only these three keys are settable here — explicit allow-list, no mass-assignment.
 * Joi (patchCallRecord) has already validated shapes/enums upstream.
 * @param {string} id
 * @param {{ notes?: string, tags?: string[], relatedTo?: { entityType: string|null, entityId: string|null } }} patch
 */
async function updateCallRecordAnnotations(id, patch = {}) {
  const $set = {};
  if (patch.notes !== undefined) $set.notes = patch.notes;
  if (patch.tags !== undefined) $set.tags = patch.tags;
  if (patch.relatedTo !== undefined) {
    $set['relatedTo.entityType'] = patch.relatedTo?.entityType ?? null;
    $set['relatedTo.entityId'] = patch.relatedTo?.entityId ?? null;
  }
  if (Object.keys($set).length === 0) {
    return CallRecord.findById(id).lean();
  }
  return CallRecord.findByIdAndUpdate(id, { $set }, { new: true, runValidators: true }).lean();
}

async function deleteCallRecord(id) {
  const record = await CallRecord.findByIdAndDelete(id).lean();
  return record;
}

async function findRecordsNeedingSync(limit = 20) {
  // Terminal statuses are off-limits for re-poll. Including 'completed' here
  // matters: a completed call without recording/transcript would otherwise be
  // re-polled by syncMissingData → updateFromExecutionDetails (raw $set, no
  // rank guard). If Bolna ages the execution out and 404s, we'd regress
  // completed (rank 10) → unknown (rank 0); the cron reconciler then escalates
  // unknown → expired. End state: recently-completed call shows as 'expired'.
  const list = await CallRecord.find({
    executionId: { $exists: true, $nin: [null, ''] },
    status: { $nin: TERMINAL_STATUSES },
    'telephonyData.provider': { $ne: 'twilio' },
    $or: [{ transcript: { $in: [null, ''] } }, { recordingUrl: { $in: [null, ''] } }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return list;
}

async function findCallRecordsToSyncForCron(options = {}) {
  const limit = Math.min(Number(options.limit) || 1000, 1000);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filter = {
    executionId: { $exists: true, $nin: [null, ''] },
    status: { $nin: ['expired'] },
    'telephonyData.provider': { $ne: 'twilio' },
    createdAt: { $gte: thirtyDaysAgo },
    $or: [
      { status: { $in: ['in_progress', 'initiated', 'failed', 'error', 'unknown'] } },
      { status: 'completed', duration: { $exists: false } },
      { status: 'completed', duration: null },
      { status: 'completed', createdAt: { $gte: twoHoursAgo } },
      { fromPhoneNumber: { $in: [null, ''] } },
      { fromPhoneNumber: { $exists: false } },
    ],
  };
  const list = await CallRecord.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  return list;
}

async function loadCallSyncService() {
  const modulePath = './callSync.service.js';
  const callSyncModule = await import(modulePath);
  return callSyncModule.default;
}
async function syncMissingData(limit = 20) {
  const records = await findRecordsNeedingSync(limit);
  let synced = 0;
  let errors = 0;
  const bolnaService = (await import('./bolna.service.js')).default;
  const callSyncService = await loadCallSyncService();
  for (const rec of records) {
    if (!rec.executionId) continue;
    const result = await bolnaService.getExecutionDetails(rec.executionId);
    if (!result.success || !result.details) {
      errors += 1;
      continue;
    }
    const applied = await callSyncService.applyEvent(
      {
        ...result.details,
        id: result.details.id ?? result.details.execution_id ?? rec.executionId,
      },
      'reconciliation'
    );
    if (applied.applied) synced += 1;
  }
  return { synced, errors };
}

async function backfillFromBolna(options = {}) {
  const callSyncService = await loadCallSyncService();
  const maxPages = Math.min(Number(options.maxPages) || 2, 10);
  const result = await callSyncService.backfillFromAgentList({ maxPages });
  return {
    backfilled: result.applied,
    errors: result.errors,
    skippedForeign: 0,
  };
}

async function fillMissingBusinessNameFromJobs(limit = 100) {
  const records = await CallRecord.find({
    $and: [
      { $nor: [{ purpose: /job_application_verification/i }] },
      { $or: [{ businessName: { $in: [null, ''] } }, { businessName: { $exists: false } }] },
      {
        $or: [
          { toPhoneNumber: { $exists: true, $nin: [null, ''] } },
          { recipientPhoneNumber: { $exists: true, $nin: [null, ''] } },
          { phone: { $exists: true, $nin: [null, ''] } },
        ],
      },
    ],
  })
    .select('_id toPhoneNumber recipientPhoneNumber phone')
    .limit(limit)
    .lean();
  if (!records.length) return { updated: 0 };

  const jobs = await Job.find({ 'organisation.phone': { $exists: true, $nin: [null, ''] } })
    .select('organisation.name organisation.phone')
    .limit(500)
    .lean();
  const phoneToOrgName = new Map();
  for (const j of jobs) {
    const p = j.organisation?.phone;
    if (!p || !j.organisation?.name) continue;
    const normalized = normalizePhone(p);
    if (normalized) phoneToOrgName.set(normalized, j.organisation.name.trim());
  }

  let updated = 0;
  for (const r of records) {
    const toPhone = r.toPhoneNumber || r.recipientPhoneNumber || r.phone;
    if (!toPhone) continue;
    const normalized = normalizePhone(toPhone);
    const name = normalized ? phoneToOrgName.get(normalized) : null;
    if (!name) continue;
    await CallRecord.updateOne({ _id: r._id }, { $set: { businessName: name } });
    updated += 1;
  }
  return { updated };
}

/**
 * Authorization check mirroring listCallRecords scoping: a non-admin may access
 * a call record only if they created its job or own its candidate (or initiated it).
 * @param {object} record - lean CallRecord with at least { job, candidate, createdBy }
 * @param {{ userId?: string, isAdmin?: boolean }} ctx
 */
async function userCanAccessCallRecord(record, { userId, isAdmin } = {}) {
  if (isAdmin) return true;
  if (!record || !userId) return false;
  if (record.createdBy && String(record.createdBy) === String(userId)) return true;
  if (record.job && (await Job.exists({ _id: record.job, createdBy: userId }))) return true;
  if (record.candidate && (await Employee.exists({ _id: record.candidate, owner: userId }))) return true;
  return false;
}

/** Load persisted recording fields for an execution (webhook may have these before Bolna API catches up). */
async function getCallRecordingFields(executionId) {
  return CallRecord.findOne({ executionId: String(executionId) })
    .select('recordingUrl telephonyData recordingArchive')
    .lean();
}

async function getCallRecordScopeFields(executionId) {
  return CallRecord.findOne({ executionId: String(executionId) })
    .select('job candidate createdBy')
    .lean();
}

/**
 * Re-derive verification + callQuality for stored records that have extractedData
 * or a transcript but no verification yet. Idempotent.
 */
export {
  userCanAccessCallRecord,
  getCallRecordScopeFields,
  getCallRecordingFields,
  assertDialerRecordMutationAllowed,
};

export async function backfillVerification(limit = 200) {
  const records = await CallRecord.find({
    'verification.extractedAt': null,
    $or: [{ extractedData: { $ne: null } }, { transcript: { $ne: null } }],
  })
    .limit(limit)
    .lean();

  let updated = 0;
  for (const r of records) {
    const insights = deriveCallInsights({
      extractedData: r.extractedData,
      transcript: r.transcript,
      status: r.status,
    });
    const now = new Date();
    const $set = {
      callQuality: { ...insights.callQuality, evaluatedAt: now },
    };
    if (r.extractedData) {
      $set.verification = { ...insights.verification, extractedAt: now };
    }
    await CallRecord.updateOne({ _id: r._id }, { $set });
    updated += 1;
  }
  return { updated, scanned: records.length };
}

export default {
  createFromWebhook,
  createRecord,
  assertDialerRecordMutationAllowed,
  upsertDialerCallRecord,
  consolidateTwilioDialerDuplicates,
  dedupeTwilioDialerRows,
  listCallRecords,
  fillMissingBusinessNameFromJobs,
  normalizePayload,
  updateFromExecutionDetails,
  updateCallRecordByExecutionId,
  findRecordsNeedingSync,
  findCallRecordsToSyncForCron,
  updateCallRecordAnnotations,
  deleteCallRecord,
  syncMissingData,
  backfillFromBolna,
  backfillVerification,
  normalizeStatus,
  userCanAccessCallRecord,
  getCallRecordScopeFields,
  getCallRecordingFields,
};


