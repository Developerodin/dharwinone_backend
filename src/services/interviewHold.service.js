import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import config from '../config/config.js';
import InterviewHold from '../models/interviewHold.model.js';
import InterviewerAvailability from '../models/interviewerAvailability.model.js';
import Meeting from '../models/meeting.model.js';
import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import * as meetingValidation from '../validations/meeting.validation.js';
import * as meetingService from './meeting.service.js';
import { notify } from './notification.service.js';
import { findFreeInterviewersAt, durationFor, resolveRound, loadApplicationContext } from './interviewSlot.service.js';
import { sendBookingLinkEmail, formatSpoken } from './interviewBooking.service.js';

const HOLD_TTL_MS = 24 * 60 * 60 * 1000;
const REMIND_BEFORE_MS = 4 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const approvalsLink = () => '/ats/interviews';

const slotTakenError = () =>
  new ApiError(httpStatus.CONFLICT, 'That interview slot is no longer available', true, '', { errorCode: 'SLOT_TAKEN' });

/** Fire-and-forget: never let a notification failure break the booking path. */
const safeNotify = (userId, options) => {
  if (!userId) return;
  notify(userId, options).catch((err) =>
    logger.warn(`[interviewHold] notify failed (user=${userId}): ${err?.message || err}`)
  );
};

const safeRelink = (applicationId, why) => {
  sendBookingLinkEmail(applicationId).catch((err) =>
    logger.warn(`[interviewHold] booking link email failed after ${why} (app=${applicationId}): ${err?.message || err}`)
  );
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Monday 00:00 UTC of the week containing `date`. */
const isoWeekStart = (date) => {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
};

/** Order interviewer ids by scheduled interviews that ISO week (fewest first). */
const orderLeastLoaded = async (interviewerIds, start) => {
  if (interviewerIds.length < 2) return interviewerIds;
  const weekStart = isoWeekStart(start);
  const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
  const users = await User.find({ _id: { $in: interviewerIds } }).select('email').lean();
  const counts = await Promise.all(
    users.map(async (u) => {
      const or = [{ 'agents.id': String(u._id) }];
      if (u.email) or.push({ 'hosts.email': new RegExp(`^${escapeRegex(u.email)}$`, 'i') });
      const n = await Meeting.countDocuments({
        status: 'scheduled',
        scheduledAt: { $gte: weekStart, $lt: weekEnd },
        $or: or,
      });
      return [String(u._id), n];
    })
  );
  const load = new Map(counts);
  return [...interviewerIds].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
};

const isDuplicateKey = (err) => err?.code === 11000 || err?.code === 11001;

/** Who approves an interview-hold request for this job: the assigned recruiter, else the job creator. */
export const approverFor = (job) => job?.assignedRecruiter || job?.createdBy || null;

/**
 * Reserve a slot for an application. Idempotent per application: an existing active hold is
 * returned with `existing: true` (retry / duplicate tool call).
 * @returns {Promise<{ hold: object, existing: boolean }>}
 */
export const createHold = async ({ applicationId, start, source, callRecordId, candidateTimezone }) => {
  const existingHold = await InterviewHold.findOne({ applicationId, active: true }).lean();
  if (existingHold) return { hold: existingHold, existing: true };

  const { application, job } = await loadApplicationContext(applicationId);
  if (application.status === 'Rejected' || application.verificationCallStatus === 'withdrawn') {
    throw new ApiError(httpStatus.CONFLICT, 'This application can no longer be scheduled', true, '', {
      errorCode: 'APPLICATION_CLOSED',
    });
  }
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime()) || startDate.getTime() <= Date.now()) throw slotTakenError();

  const durationMinutes = durationFor(application);
  const pool = (job.interviewerPool || []).map(String);
  const free = await findFreeInterviewersAt({ interviewerIds: pool, start: startDate, durationMinutes });
  if (!free.length) throw slotTakenError();
  const ordered = await orderLeastLoaded(free, startDate);
  const round = await resolveRound(application);

  let hold = null;
  for (const interviewerId of ordered) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const doc = await InterviewHold.create({
        applicationId,
        jobId: job._id,
        candidateId: application.candidate,
        interviewerId,
        start: startDate,
        durationMinutes,
        candidateTimezone: candidateTimezone || undefined,
        round,
        source,
        callRecordId: callRecordId || undefined,
        expiresAt: new Date(Date.now() + HOLD_TTL_MS),
      });
      hold = doc.toObject();
      break;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      if (err?.keyPattern?.applicationId) {
        // A concurrent request won the per-application index: return its hold.
        // eslint-disable-next-line no-await-in-loop
        const winner = await InterviewHold.findOne({ applicationId, active: true }).lean();
        if (winner) return { hold: winner, existing: true };
      }
      // Interviewer index collision (someone took this interviewer at this time) — try the next.
    }
  }
  if (!hold) throw slotTakenError();

  const candidate = await Employee.findById(application.candidate).select('fullName').lean();
  const when = formatSpoken(startDate, candidateTimezone || 'Asia/Kolkata');
  const msg = `${candidate?.fullName || 'A candidate'} picked ${when} for ${job.title}. Approve or reject within 24h.`;
  const base = { type: 'meeting', title: 'Interview slot awaiting approval', message: msg, link: approvalsLink() };
  const approverId = approverFor(job);
  safeNotify(approverId, {
    ...base,
    email: {
      subject: `Interview slot awaiting approval — ${job.title}`,
      text: `${msg}\n\n${String(config.frontendBaseUrl || '').replace(/\/$/, '')}${approvalsLink()}`,
    },
  });
  if (String(hold.interviewerId) !== String(approverId)) safeNotify(hold.interviewerId, base);

  return { hold, existing: false };
};

/**
 * Approve a held slot: creates the interview Meeting. The atomic held->approving claim runs
 * BEFORE createMeeting so a double-click cannot create two Meetings. On any failure the hold
 * reverts to held and the error propagates.
 */
export const approveHold = async (holdId, user) => {
  const now = new Date();
  const claimed = await InterviewHold.findOneAndUpdate(
    { _id: holdId, status: 'held', expiresAt: { $gt: now } },
    { $set: { status: 'approving' } },
    { new: true }
  ).lean();
  if (!claimed) throw new ApiError(httpStatus.CONFLICT, 'This hold was already decided or has expired');

  const approverId = user?._id || user?.id;
  try {
    const [job, candidate, interviewer, availability] = await Promise.all([
      Job.findById(claimed.jobId).select('title').lean(),
      Employee.findById(claimed.candidateId).select('fullName email phoneNumber').lean(),
      User.findById(claimed.interviewerId).select('name email').lean(),
      InterviewerAvailability.findOne({ user: claimed.interviewerId }).select('timezone').lean(),
    ]);
    if (!interviewer?.email) throw new ApiError(httpStatus.BAD_REQUEST, 'Assigned interviewer has no email');

    // No round.index: createMeeting allocates it.
    const round = {};
    if (claimed.round?.type) round.type = claimed.round.type;
    if (claimed.round?.label) round.label = claimed.round.label;
    if (claimed.round?.planKey) round.planKey = claimed.round.planKey;

    const rawBody = {
      title: `Interview: ${candidate?.fullName || 'Candidate'} — ${job?.title || 'Role'}`,
      scheduledAt: claimed.start,
      timezone: claimed.candidateTimezone || availability?.timezone || 'Asia/Kolkata',
      durationMinutes: claimed.durationMinutes,
      hosts: [{ nameOrRole: interviewer.name || 'Interviewer', email: interviewer.email }],
      agents: [{ id: String(interviewer._id), name: interviewer.name || '', email: interviewer.email }],
      jobPosition: String(claimed.jobId),
      interviewType: 'Video',
      candidate: candidate
        ? {
            id: String(claimed.candidateId),
            name: candidate.fullName || '',
            email: candidate.email || null,
            phone: candidate.phoneNumber || '',
          }
        : null,
      recruiter: { id: String(approverId), name: user?.name || '', email: user?.email || null },
      applicationId: String(claimed.applicationId),
      ...(Object.keys(round).length ? { round } : {}),
    };
    // Same Joi schema POST /meetings uses, so createMeeting receives its defaults.
    const { value: body, error } = meetingValidation.createMeeting.body.validate(rawBody, { abortEarly: false });
    if (error) throw new ApiError(httpStatus.BAD_REQUEST, error.details.map((d) => d.message).join(', '));

    const meeting = await meetingService.createMeeting(body, approverId);
    const meetingId = meeting?._id || meeting?.id;
    const approved = await InterviewHold.findByIdAndUpdate(
      claimed._id,
      { $set: { status: 'approved', active: false, meetingId, decidedBy: approverId, decidedAt: new Date() } },
      { new: true }
    ).lean();
    return { hold: approved, meeting };
  } catch (err) {
    await InterviewHold.updateOne({ _id: claimed._id, status: 'approving' }, { $set: { status: 'held' } }).catch((e) =>
      logger.error(`[interviewHold] failed to revert hold ${claimed._id} to held: ${e?.message || e}`)
    );
    throw err;
  }
};

export const rejectHold = async (holdId, user, reason) => {
  const hold = await InterviewHold.findOneAndUpdate(
    { _id: holdId, status: 'held' },
    {
      $set: {
        status: 'rejected',
        active: false,
        decidedBy: user?._id || user?.id,
        decidedAt: new Date(),
        rejectReason: reason || undefined,
      },
    },
    { new: true }
  ).lean();
  if (!hold) throw new ApiError(httpStatus.CONFLICT, 'This hold was already decided or has expired');
  safeRelink(hold.applicationId, 'reject');
  return hold;
};

export const cancelHoldsForApplication = async (applicationId) => {
  const res = await InterviewHold.updateMany({ applicationId, status: 'held' }, { $set: { status: 'cancelled', active: false } });
  return res.modifiedCount || 0;
};

/** Scheduler: held holds past expiry become expired; the candidate is emailed a fresh link. */
export const expireHolds = async () => {
  const now = new Date();
  const due = await InterviewHold.find({ status: 'held', expiresAt: { $lte: now } }).select('_id applicationId').lean();
  let expired = 0;
  for (const h of due) {
    // eslint-disable-next-line no-await-in-loop
    const res = await InterviewHold.updateOne({ _id: h._id, status: 'held' }, { $set: { status: 'expired', active: false } });
    if (res.modifiedCount) {
      expired += 1;
      safeRelink(h.applicationId, 'expiry');
    }
  }
  return expired;
};

/** Scheduler: one reminder to the hold's approver (assigned recruiter, else job creator) + interviewer when a hold is within 4h of expiry. */
export const remindExpiring = async () => {
  const now = new Date();
  const due = await InterviewHold.find({
    status: 'held',
    expiresAt: { $gt: now, $lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
    expiryReminderSentAt: null,
  })
    .select('_id jobId interviewerId')
    .lean();
  let sent = 0;
  for (const h of due) {
    // Claim first so two scheduler processes cannot both remind.
    // eslint-disable-next-line no-await-in-loop
    const res = await InterviewHold.updateOne(
      { _id: h._id, expiryReminderSentAt: null },
      { $set: { expiryReminderSentAt: new Date() } }
    );
    if (!res.modifiedCount) continue;
    // eslint-disable-next-line no-await-in-loop
    const job = await Job.findById(h.jobId).select('title createdBy assignedRecruiter').lean();
    const opts = {
      type: 'meeting',
      title: 'Interview hold expiring soon',
      message: `A candidate's interview slot for ${job?.title || 'a job'} expires in under 4 hours. Approve or reject it.`,
      link: approvalsLink(),
    };
    const approverId = approverFor(job);
    safeNotify(approverId, opts);
    if (String(h.interviewerId) !== String(approverId)) safeNotify(h.interviewerId, opts);
    sent += 1;
  }
  return sent;
};

export const listHolds = async ({ status = 'held', jobId } = {}) => {
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (jobId) filter.jobId = jobId;
  return InterviewHold.find(filter)
    .sort({ start: 1 })
    .limit(500)
    .populate('candidateId', 'fullName email')
    .populate('jobId', 'title')
    .populate('interviewerId', 'name email')
    .lean();
};

/** Call-record view of a hold. Authoritative booking state, not the LLM's reading of the call. */
const toInterviewSlot = (h) => ({
  holdId: String(h._id),
  status: h.status,
  start: h.start,
  durationMinutes: h.durationMinutes,
  candidateTimezone: h.candidateTimezone || null,
  interviewerName: h.interviewerId?.name || null,
  meetingId: h.meetingId ? String(h.meetingId) : null,
  expiresAt: h.expiresAt,
  rejectReason: h.rejectReason || null,
  source: h.source,
});

/**
 * Attach `interviewSlot` (latest hold per call record, or null) to lean call records.
 * One query for the whole page. Returns new objects; inputs are not mutated.
 * Only holds carrying callRecordId (AI-call holds) match — a slot the candidate later
 * books through the emailed link has no callRecordId and is not shown here.
 */
export const attachInterviewSlots = async (records) => {
  if (!Array.isArray(records) || records.length === 0) return records;
  const ids = records.map((r) => r?._id).filter(Boolean);
  const holds = ids.length
    ? await InterviewHold.find({ callRecordId: { $in: ids } })
        .select('callRecordId status start durationMinutes candidateTimezone interviewerId meetingId expiresAt rejectReason source createdAt')
        .sort({ createdAt: -1 })
        .populate('interviewerId', 'name email')
        .lean()
    : [];
  const latest = new Map();
  for (const h of holds) {
    const key = String(h.callRecordId);
    if (!latest.has(key)) latest.set(key, h);
  }
  return records.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const h = latest.get(String(r._id));
    return { ...r, interviewSlot: h ? toInterviewSlot(h) : null };
  });
};
