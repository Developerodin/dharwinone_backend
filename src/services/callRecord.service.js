import CallRecord, { TERMINAL_STATUSES, rankOf, isTerminal } from '../models/callRecord.model.js';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import config from '../config/config.js';
import { normalizePhone } from '../utils/phone.js';
import { deriveCallInsights } from '../utils/candidateExtraction.js';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
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
    cancelled: 'failed',
    canceled: 'failed',
    stopped: 'failed',
    initiate: 'initiated',
    initiated: 'initiated',
    'no-answer': 'no_answer',
    'call-disconnected': 'call_disconnected',
    'in-progress': 'in_progress',
    'balance-low': 'failed',
    queued: 'initiated',
    ringing: 'in_progress',
  };
  return statusMap[s] || s;
}

/** Twilio browser dialer rows — keyed by CallSid, not Bolna execution ids. */
function isTwilioDialerRecord(record) {
  if (!record) return false;
  if (record.telephonyData?.provider === 'twilio') return true;
  return /^CA[a-f0-9]{32}$/i.test(String(record.executionId || ''));
}

const TWILIO_DEDUPE_BUCKET_MS = 2 * 60 * 1000;

function twilioDialerGroupKey(record) {
  const to = normalizePhone(record.toPhoneNumber || record.recipientPhoneNumber || record.phone || '') || '';
  const from = normalizePhone(record.fromPhoneNumber || record.userNumber || '') || '';
  const createdBy = String(record.createdBy || '');
  const t = record.createdAt ? new Date(record.createdAt).getTime() : 0;
  const bucket = Number.isFinite(t) ? Math.floor(t / TWILIO_DEDUPE_BUCKET_MS) : 0;
  return `${createdBy}|${to}|${from}|${bucket}`;
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
    andConditions.push({ status: String(options.status).trim() });
  }
  if (options.language && String(options.language).trim() && String(options.language).toLowerCase() !== 'all') {
    andConditions.push({ language: String(options.language).trim() });
  }

  if (options.channel === 'dialer' && options.userId) {
    // Dialer Recent: only calls this user placed from the dialer. Dialer calls
    // are owned (createdBy) and carry no job/candidate link (see upsertDialerCallRecord).
    // Forced even for admins — the dialer shows your own calls, not the whole tenant's.
    andConditions.push({ createdBy: options.userId, candidate: null, job: null });
  } else if (!options.isAdmin && options.userId) {
    const [jobIds, candidateIds] = await Promise.all([
      Job.distinct('_id', { createdBy: options.userId }),
      Employee.distinct('_id', { owner: options.userId }),
    ]);
    andConditions.push({
      $or: [
        { job: { $in: jobIds } },
        { candidate: { $in: candidateIds } },
        // Dialer (Twilio) calls have no job/candidate link — scope by initiator
        // so the agent who placed the call sees it in their records.
        { createdBy: options.userId },
      ],
    });
  }

  const filter = andConditions.length === 0 ? {} : andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  const [results, total] = await Promise.all([
    CallRecord.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    CallRecord.countDocuments(filter),
  ]);

  const dedupedResults = dedupeTwilioDialerRows(results);

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
 * Upsert a Twilio dialer CallRecord keyed by the Twilio CallSid (executionId).
 * Used by the Twilio voice/status/recording webhooks. createdBy/source are set
 * once on insert; status only moves forward (monotonic rank guard).
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
} = {}) {
  if (!executionId) return null;
  const set = {};
  if (toPhoneNumber) {
    const t = String(toPhoneNumber);
    set.toPhoneNumber = t;
    set.recipientPhoneNumber = t;
    set.phone = t;
  }
  if (fromPhoneNumber) {
    const f = String(fromPhoneNumber);
    set.fromPhoneNumber = f;
    set.userNumber = f;
  }
  if (duration != null && !Number.isNaN(Number(duration))) set.duration = Number(duration);
  set['telephonyData.provider'] = provider;
  if (direction) set['telephonyData.direction'] = direction;

  if (status) {
    const st = normalizeStatus(status);
    const existing = await CallRecord.findOne({ executionId: String(executionId) })
      .select('status statusRank')
      .lean();
    const incomingRank = rankOf(st);
    const existingRank = existing ? existing.statusRank ?? rankOf(existing.status) : -1;
    if (incomingRank >= existingRank) {
      set.status = st;
      set.statusRank = incomingRank;
      set.statusUpdatedAt = new Date();
      if (isTerminal(st)) set.completedAt = new Date();
    }
  }

  const setOnInsert = {
    executionId: String(executionId),
    source,
    createdBy: createdBy || null,
  };
  if (provider === 'twilio') {
    // Twilio CallSid rows are never Bolna executions — skip Bolna reconcilers.
    setOnInsert.bolnaVerifiedAt = new Date();
  }
  // Backfill: preserve the real call time instead of "now".
  if (createdAt) {
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (!Number.isNaN(d.getTime())) setOnInsert.createdAt = d;
  }
  return CallRecord.findOneAndUpdate(
    { executionId: String(executionId) },
    { $set: set, $setOnInsert: setOnInsert },
    { new: true, upsert: true }
  ).lean();
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

async function syncMissingData(limit = 20) {
  const records = await findRecordsNeedingSync(limit);
  let synced = 0;
  let errors = 0;
  const bolnaService = (await import('./bolna.service.js')).default;
  for (const rec of records) {
    if (!rec.executionId) continue;
    const result = await bolnaService.getExecutionDetails(rec.executionId);
    if (!result.success || !result.details) {
      errors += 1;
      continue;
    }
    const updated = await updateFromExecutionDetails(rec.executionId, result.details);
    if (updated) synced += 1;
  }
  return { synced, errors };
}

function executionToCallRecordDoc(exec, agentId) {
  const executionId = exec.id ?? exec.execution_id;
  if (!executionId) return null;
  const telephony = exec.telephony_data || {};
  const userData = exec.user_data || {};
  const execAgentKey = normalizeKey(exec.agent_id ?? exec.agentId ?? agentId);
  const jobAgentKey = normalizeKey(config.bolna.agentId);
  const candAgentKey = normalizeKey(config.bolna.candidateAgentId);
  let purposeHint = '';
  if (jobAgentKey && candAgentKey && jobAgentKey !== candAgentKey) {
    if (execAgentKey === candAgentKey) purposeHint = 'job_application_verification';
    else if (execAgentKey === jobAgentKey) purposeHint = 'job_posting_verification';
  }
  const businessName =
    businessNameFromBolnaUserData(userData, purposeHint) ||
    (userData.organisation ?? userData.name ?? userData.candidate_name
      ? String(userData.organisation || userData.name || userData.candidate_name).trim()
      : undefined);
  const duration =
    telephony.duration != null
      ? parseInt(telephony.duration, 10)
      : exec.conversation_time != null
        ? Number(exec.conversation_time)
        : undefined;
  const doc = {
    executionId: String(executionId),
    agentId: (exec.agent_id ?? exec.agentId ?? agentId) ? String(exec.agent_id ?? exec.agentId ?? agentId).trim() : undefined,
    status: normalizeStatus(exec.status),
    toPhoneNumber: telephony.to_number || undefined,
    recipientPhoneNumber: telephony.to_number || undefined,
    phone: telephony.to_number || undefined,
    fromPhoneNumber: telephony.from_number || undefined,
    userNumber: telephony.from_number || undefined,
    businessName: businessName || undefined,
    transcript: exec.transcript || undefined,
    duration: Number.isNaN(duration) ? undefined : duration,
    recordingUrl: telephony.recording_url || undefined,
    errorMessage: exec.error_message || undefined,
    completedAt: exec.updated_at ? new Date(exec.updated_at) : null,
    raw: { fromList: true },
  };
  if (exec.created_at) doc.createdAt = new Date(exec.created_at);
  return doc;
}

/**
 * Decide whether a Bolna execution returned by the agent-list endpoint is
 * actually OURS, not a foreign-tenant call leaking under a shared agent_id.
 * Two ownership signals (any one is enough):
 *   1. telephony_data.from_number matches BOLNA_FROM_PHONE_NUMBER (our caller id)
 *   2. user_data carries one of our DB identifiers (job_id / candidate_id / application_id)
 * If neither, we skip — better a missing row than a permanent ghost.
 */
function execLooksOwned(exec, ourFromPhone) {
  const telephony = exec.telephony_data || {};
  if (ourFromPhone) {
    const from = String(telephony.from_number || '').replace(/\D/g, '');
    const ours = String(ourFromPhone).replace(/\D/g, '');
    if (ours && from && (from === ours || from.endsWith(ours.slice(-10)))) return true;
  }
  const ud = exec.user_data || {};
  const idCandidates = [
    ud.job_id, ud.jobId,
    ud.candidate_id, ud.candidateId,
    ud.application_id, ud.applicationId,
  ];
  if (idCandidates.some((v) => v != null && String(v).trim().length > 0)) return true;
  return false;
}

async function backfillFromBolna(options = {}) {
  const bolnaService = (await import('./bolna.service.js')).default;
  const config = (await import('../config/config.js')).default;
  const maxPages = Math.min(Number(options.maxPages) || 2, 10);
  const ourFromPhone = config.bolna?.fromPhoneNumber || '';
  let backfilled = 0;
  let errors = 0;
  let skippedForeign = 0;

  // Backfill from every owned agent: job recruiter, candidate, AND any retired
  // agents listed in BOLNA_ADDITIONAL_AGENT_IDS that still hold call history.
  const agentIds =
    Array.isArray(config.bolna?.allAgentIds) && config.bolna.allAgentIds.length
      ? config.bolna.allAgentIds
      : [config.bolna?.agentId, config.bolna?.candidateAgentId].filter(Boolean);
  const uniqueAgentIds = [...new Set(agentIds)];

  for (const agentId of uniqueAgentIds) {
    if (!agentId) continue;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await bolnaService.getAgentExecutions({
        agentId,
        page_number: page,
        page_size: 50,
      });
      if (!result.success || !result.data || !Array.isArray(result.data)) {
        errors += 1;
        break;
      }
      for (const exec of result.data) {
        const doc = executionToCallRecordDoc(exec, agentId);
        if (!doc) continue;
        try {
          const existing = await CallRecord.findOne({ executionId: doc.executionId }).lean();
          // Foreign-call guard: only allow inserts (not updates) for execs
          // that look like ours. An existing row may legitimately be ours
          // even if user_data is sparse (Bolna sometimes drops it on aged
          // executions), so we let updates through unconditionally.
          if (!existing && !execLooksOwned(exec, ourFromPhone)) {
            skippedForeign += 1;
            continue;
          }
          if (existing) {
            // Rank guard. Bolna's agent-list can return status='unknown' for
            // executions that are queued / aged / errored in a way Bolna no
            // longer knows about. Letting raw $set overwrite a terminal row
            // (rank 10) lets the cron reconciler later escalate to 'expired'.
            const existingRank = existing.statusRank ?? rankOf(existing.status);
            const incomingRank = rankOf(doc.status);
            const sameRankTerminalEnrichment =
              incomingRank === existingRank &&
              isTerminal(doc.status) &&
              isTerminal(existing.status);
            const allowStatusWrite =
              incomingRank > existingRank || sameRankTerminalEnrichment;
            await CallRecord.updateOne(
              { executionId: doc.executionId },
            {
              $set: {
                ...(allowStatusWrite && {
                  status: doc.status,
                  statusRank: incomingRank,
                  statusUpdatedAt: new Date(),
                }),
                ...(doc.agentId && { agentId: doc.agentId }),
                ...(doc.toPhoneNumber && {
                  toPhoneNumber: doc.toPhoneNumber,
                  recipientPhoneNumber: doc.recipientPhoneNumber,
                  phone: doc.phone,
                }),
                ...(doc.fromPhoneNumber && {
                  fromPhoneNumber: doc.fromPhoneNumber,
                  userNumber: doc.userNumber,
                }),
                ...(doc.transcript && { transcript: doc.transcript }),
                ...(doc.duration != null && { duration: doc.duration }),
                ...(doc.recordingUrl && { recordingUrl: doc.recordingUrl }),
                ...(doc.errorMessage != null && { errorMessage: doc.errorMessage }),
                ...(doc.completedAt && { completedAt: doc.completedAt }),
              },
            }
            );
          } else {
            // Tag provenance + Bolna-verified (we just got it from Bolna's
            // agent-list, so by definition it exists upstream).
            await CallRecord.create({
              ...doc,
              source: 'backfill',
              bolnaVerifiedAt: new Date(),
            });
            backfilled += 1;
          }
        } catch (_) {
          errors += 1;
        }
      }
    if (!result.has_more) break;
  }
  }
  if (skippedForeign > 0) {
    const logger = (await import('../config/logger.js')).default;
    logger.info(`[callRecord backfill] skipped ${skippedForeign} foreign exec(s) lacking ownership marker`);
  }
  return { backfilled, errors, skippedForeign };
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
    .select('recordingUrl telephonyData')
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
export { userCanAccessCallRecord, getCallRecordScopeFields, getCallRecordingFields };

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
  upsertDialerCallRecord,
  consolidateTwilioDialerDuplicates,
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

