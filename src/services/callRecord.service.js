import CallRecord from '../models/callRecord.model.js';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import config from '../config/config.js';
import { normalizePhone } from '../utils/phone.js';

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

async function createFromWebhook(payload) {
  const doc = normalizePayload(payload);
  if (!doc.executionId) {
    const record = await CallRecord.create(doc);
    return record;
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
  const record = await CallRecord.create(doc);
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

  if (!options.isAdmin && options.userId) {
    const [jobIds, candidateIds] = await Promise.all([
      Job.distinct('_id', { createdBy: options.userId }),
      Employee.distinct('_id', { owner: options.userId }),
    ]);
    andConditions.push({
      $or: [
        { job: { $in: jobIds } },
        { candidate: { $in: candidateIds } },
      ],
    });
  }

  const filter = andConditions.length === 0 ? {} : andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  const [results, total] = await Promise.all([
    CallRecord.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    CallRecord.countDocuments(filter),
  ]);

  // executionId -> Job (job post verification) or JobApplication (candidate verification)
  const executionIds = results.map((r) => String(r.executionId || '')).filter(Boolean);
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
  for (const r of results) {
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
  const needCandidateName = results.filter((r) => r.candidate && !(r.businessName && r.businessName.trim()));
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
  for (const r of results) {
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

  const totalPages = Math.ceil(total / limit);
  return { results, total, totalPages, page, limit };
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
  return CallRecord.create(doc);
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

async function deleteCallRecord(id) {
  const record = await CallRecord.findByIdAndDelete(id).lean();
  return record;
}

async function findRecordsNeedingSync(limit = 20) {
  const list = await CallRecord.find({
    executionId: { $exists: true, $nin: [null, ''] },
    status: { $nin: ['expired'] },
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

async function backfillFromBolna(options = {}) {
  const bolnaService = (await import('./bolna.service.js')).default;
  const config = (await import('../config/config.js')).default;
  const maxPages = Math.min(Number(options.maxPages) || 2, 10);
  let backfilled = 0;
  let errors = 0;

  // Backfill from both job recruiter agent and candidate agent
  const agentIds = [
    config.bolna?.agentId,
    config.bolna?.candidateAgentId,
  ].filter(Boolean);
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
          if (existing) {
            await CallRecord.updateOne(
              { executionId: doc.executionId },
            {
              $set: {
                status: doc.status,
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
            await CallRecord.create(doc);
            backfilled += 1;
          }
        } catch (_) {
          errors += 1;
        }
      }
    if (!result.has_more) break;
  }
  }
  return { backfilled, errors };
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

export default {
  createFromWebhook,
  createRecord,
  listCallRecords,
  fillMissingBusinessNameFromJobs,
  normalizePayload,
  updateFromExecutionDetails,
  updateCallRecordByExecutionId,
  findRecordsNeedingSync,
  findCallRecordsToSyncForCron,
  deleteCallRecord,
  syncMissingData,
  backfillFromBolna,
  normalizeStatus,
};

