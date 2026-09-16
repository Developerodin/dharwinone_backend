import Meeting from '../models/meeting.model.js';
import JobApplication from '../models/jobApplication.model.js';
import Offer from '../models/offer.model.js';
import { SITUATIONS, SCAN_LIMIT } from '../constants/smartNudge.situations.js';
import { didCandidateJoin, daysBetweenUtc, isObjectIdHex, buildEvent, uniqueEvents } from './smartNudge.helpers.js';

const STALE_APP_STATUSES = ['Applied', 'Screening', 'Interview'];

/**
 * Recruiter-side user ids from a meeting (valid ObjectIds only).
 * @param {object} meeting
 * @returns {string[]}
 */
export const recruiterUserIds = (meeting) => {
  const ids = [];
  const add = (id) => {
    if (isObjectIdHex(id)) ids.push(String(id));
  };
  add(meeting.recruiter?.id);
  add(meeting.createdBy);
  for (const a of meeting.agents || []) add(a?.id);
  return [...new Set(ids)];
};

/**
 * Interview ended and the candidate never joined.
 * @param {{ now?: Date, meetings?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectInterviewNoShows = async ({ now = new Date(), meetings } = {}) => {
  const cfg = SITUATIONS.interview_no_show;
  const lookback = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const docs =
    meetings ||
    (await Meeting.find({
      status: 'ended',
      scheduledAt: { $lte: now, $gte: lookback },
    })
      .select(
        'meetingId title scheduledAt candidate recruiter createdBy agents candidateId participantRoster interviewResult'
      )
      .limit(SCAN_LIMIT)
      .lean());

  const events = [];
  for (const m of docs) {
    if (didCandidateJoin(m)) continue;
    const label = m.title || 'Interview';
    const entityId = String(m._id);
    const relatedEntity = { type: 'meeting', id: m.meetingId || entityId };
    const meta = { meetingId: m.meetingId, navTarget: 'interviews_list' };

    if (m.candidate?.email) {
      events.push(
        buildEvent({
          situation: 'interview_no_show',
          audience: 'candidate',
          email: m.candidate.email,
          entityType: 'meeting',
          entityId,
          days: 0,
          label,
          link: '/ats/my-applications',
          relatedEntity,
          metadata: meta,
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
    for (const uid of recruiterUserIds(m)) {
      events.push(
        buildEvent({
          situation: 'interview_no_show',
          audience: 'recruiter',
          userId: uid,
          entityType: 'meeting',
          entityId,
          days: 0,
          label,
          link: '/ats/interviews',
          relatedEntity,
          metadata: meta,
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Conclusion already sent, result still pending after the extra delay.
 * @param {{ now?: Date, meetings?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectResultOverdue = async ({ now = new Date(), meetings } = {}) => {
  const cfg = SITUATIONS.result_overdue;
  const cutoff = new Date(now.getTime() - cfg.hoursAfterConclusion * 60 * 60 * 1000);
  const docs =
    meetings ||
    (await Meeting.find({
      interviewResult: 'pending',
      conclusionNotifiedAt: { $ne: null, $lte: cutoff },
    })
      .select('meetingId title recruiter createdBy agents conclusionNotifiedAt')
      .limit(SCAN_LIMIT)
      .lean());

  const events = [];
  for (const m of docs) {
    const label = m.title || 'Interview';
    const entityId = String(m._id);
    const days = daysBetweenUtc(now, m.conclusionNotifiedAt);
    for (const uid of recruiterUserIds(m)) {
      events.push(
        buildEvent({
          situation: 'result_overdue',
          audience: 'recruiter',
          userId: uid,
          entityType: 'meeting',
          entityId,
          days,
          label,
          link: '/ats/interviews',
          relatedEntity: { type: 'meeting', id: m.meetingId || entityId },
          metadata: { meetingId: m.meetingId, navTarget: 'interviews_list' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Applications stuck in early pipeline statuses.
 * @param {{ now?: Date, applications?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectApplicationStale = async ({ now = new Date(), applications } = {}) => {
  const cfg = SITUATIONS.application_stale;
  const staleBefore = new Date(now.getTime() - cfg.staleDays * 24 * 60 * 60 * 1000);
  const docs =
    applications ||
    (await JobApplication.find({
      status: { $in: STALE_APP_STATUSES },
      updatedAt: { $lte: staleBefore },
    })
      .select('job candidate status updatedAt')
      .populate('job', 'title createdBy')
      .limit(SCAN_LIMIT)
      .lean());

  const events = [];
  for (const app of docs) {
    const createdBy = app.job?.createdBy;
    if (!isObjectIdHex(createdBy)) continue;
    const label = app.job?.title || 'a role';
    const days = daysBetweenUtc(now, app.updatedAt);
    events.push(
      buildEvent({
        situation: 'application_stale',
        audience: 'recruiter',
        userId: createdBy,
        entityType: 'job_application',
        entityId: String(app._id),
        days,
        label,
        link: '/ats/applications',
        relatedEntity: { type: 'job_application', id: String(app._id) },
        metadata: { jobId: app.job?._id ? String(app.job._id) : null, navTarget: 'applications' },
        severity: cfg.severity,
        overlapTypes: cfg.overlapTypes,
      })
    );
  }
  return uniqueEvents(events);
};

/**
 * Interview selected but no offer exists for that candidate+job after 2 days.
 * @param {{ now?: Date, meetings?: object[], existingOffers?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectSelectedNoOffer = async ({ now = new Date(), meetings, existingOffers } = {}) => {
  const cfg = SITUATIONS.selected_no_offer;
  const cutoff = new Date(now.getTime() - cfg.staleDays * 24 * 60 * 60 * 1000);
  const docs =
    meetings ||
    (await Meeting.find({
      interviewResult: 'selected',
      $or: [{ interviewCompletedAt: { $lte: cutoff } }, { interviewCompletedAt: null, scheduledAt: { $lte: cutoff } }],
    })
      .select('meetingId title candidateId jobId recruiter createdBy agents interviewCompletedAt scheduledAt')
      .limit(SCAN_LIMIT)
      .lean());

  const eligible = docs.filter((m) => isObjectIdHex(m.candidateId) && isObjectIdHex(m.jobId));
  if (!eligible.length) return [];

  const offers =
    existingOffers ||
    (await Offer.find({
      $or: eligible.map((m) => ({ candidate: m.candidateId, job: m.jobId })),
    })
      .select('candidate job')
      .lean());

  const offered = new Set(offers.map((o) => `${o.candidate}|${o.job}`));
  const events = [];
  for (const m of eligible) {
    if (offered.has(`${m.candidateId}|${m.jobId}`)) continue;
    const label = m.title || 'the role';
    const days = daysBetweenUtc(now, m.interviewCompletedAt || m.scheduledAt);
    for (const uid of recruiterUserIds(m)) {
      events.push(
        buildEvent({
          situation: 'selected_no_offer',
          audience: 'recruiter',
          userId: uid,
          entityType: 'meeting',
          entityId: String(m._id),
          days,
          label,
          link: '/ats/offers-placement',
          relatedEntity: { type: 'meeting', id: m.meetingId || String(m._id) },
          metadata: { navTarget: 'offers' },
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};

/**
 * Offer sitting Sent: candidate at day 2 or validity-1d; recruiter at day 4.
 * Validity-1d is high severity (email).
 * @param {{ now?: Date, offers?: object[] }} [opts]
 * @returns {Promise<object[]>}
 */
export const detectOfferAging = async ({ now = new Date(), offers } = {}) => {
  const cfg = SITUATIONS.offer_aging;
  const docs =
    offers ||
    (await Offer.find({ status: 'Sent' })
      .select('candidate createdBy sentAt createdAt offerValidityDate job')
      .populate('job', 'title')
      .populate('candidate', 'email owner fullName')
      .limit(SCAN_LIMIT)
      .lean());

  const events = [];
  for (const o of docs) {
    const sent = o.sentAt || o.createdAt;
    if (!sent) continue;
    const ageDays = daysBetweenUtc(now, sent);
    const label = o.job?.title || 'your offer';
    const entityId = String(o._id);
    const relatedEntity = { type: 'offer', id: entityId };
    const meta = { navTarget: 'offers' };

    let validityDays = null;
    if (o.offerValidityDate) {
      validityDays = daysBetweenUtc(o.offerValidityDate, now);
    }

    const candidateDue = ageDays >= cfg.candidateDays || validityDays === 1;
    const recruiterDue = ageDays >= cfg.recruiterDays;
    if (!candidateDue && !recruiterDue) continue;

    const high = validityDays === 1;

    if (candidateDue) {
      const candEmail = o.candidate?.email;
      const candUser = isObjectIdHex(o.candidate?.owner) ? String(o.candidate.owner) : null;
      events.push(
        buildEvent({
          situation: 'offer_aging',
          audience: 'candidate',
          userId: candUser,
          email: candEmail,
          entityType: 'offer',
          entityId,
          days: high ? 1 : ageDays,
          label,
          link: '/ats/my-applications',
          relatedEntity,
          metadata: meta,
          severity: high ? 'high' : cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
    if (recruiterDue && isObjectIdHex(o.createdBy)) {
      events.push(
        buildEvent({
          situation: 'offer_aging',
          audience: 'recruiter',
          userId: o.createdBy,
          entityType: 'offer',
          entityId,
          days: ageDays,
          label,
          link: '/ats/offers-placement',
          relatedEntity,
          metadata: meta,
          severity: cfg.severity,
          overlapTypes: cfg.overlapTypes,
        })
      );
    }
  }
  return uniqueEvents(events);
};
