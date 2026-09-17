import httpStatus from 'http-status';
import Meeting from '../models/meeting.model.js';
import ApiError from '../utils/ApiError.js';
import { meetingScope } from './visibilityScope.service.js';
import { criteriaForMeeting, listEvaluationsForMeetings } from './interviewEvaluation.service.js';

/**
 * Display names for round types. Spelled out rather than title-cased, because
 * `hr` -> "Hr" and `hiring_manager` -> "Hiring_manager" are both wrong.
 */
const ROUND_TYPE_LABELS = Object.freeze({
  screening: 'Screening',
  technical: 'Technical',
  panel: 'Panel',
  hr: 'HR',
  behavioral: 'Behavioural',
  hiring_manager: 'Hiring Manager',
  culture: 'Culture Fit',
  final: 'Final',
  other: 'Other',
});

/**
 * The round's display name. Built server-side so the list, the detail page, the history
 * panel and the export all read the same — four copies of this rule would drift.
 *
 * @param {{index?: number, type?: string, label?: string}|null} round
 * @returns {string}
 */
export const buildRoundName = (round) => {
  const index = Number(round?.index);
  const hasIndex = Number.isFinite(index) && index > 0;
  const label = String(round?.label || '').trim();
  const typeLabel = round?.type ? ROUND_TYPE_LABELS[round.type] || round.type : '';
  const qualifier = label || typeLabel;

  if (hasIndex && qualifier) return `Round ${index} — ${qualifier}`;
  if (hasIndex) return `Round ${index}`;
  if (qualifier) return qualifier;
  return 'Interview';
};

/**
 * Present a legacy Meeting.interviewScorecard as one evaluation row.
 *
 * The old field is read but no longer written, so history keeps showing it rather than
 * losing it. `weightedScore` is null on purpose: the legacy rubric had no weights, so
 * any number here would be invented.
 *
 * @param {object|null} meeting
 * @returns {object|null}
 */
export const legacyScorecardAsEvaluation = (meeting) => {
  const card = meeting?.interviewScorecard;
  const ratings = Array.isArray(card?.ratings) ? card.ratings : [];
  const comment = String(card?.comment || '').trim();
  if (!ratings.length && !comment) return null;

  const scorer = card.scoredBy;
  return {
    id: null,
    evaluatorName: scorer?.name || 'Unknown',
    evaluatorEmail: scorer?.email || '',
    weightedScore: null,
    coveragePct: 0,
    scoredCount: ratings.length,
    totalCount: ratings.length,
    isComplete: false,
    comment,
    ratings: ratings.map((r) => ({
      key: r.criterion,
      label: r.criterion,
      weight: null,
      rating: r.rating ?? null,
      notApplicable: false,
    })),
    submittedAt: card.scoredAt || null,
    isLegacy: true,
  };
};

/** Interviewers on a round: agents, hosts and the recruiter are separate lists, flattened. */
const interviewersFor = (meeting) => {
  const people = [];
  for (const agent of meeting.agents || []) {
    if (agent?.email || agent?.name) {
      people.push({ name: agent.name || '', email: agent.email || '', role: 'agent' });
    }
  }
  for (const host of meeting.hosts || []) {
    if (host?.email) {
      people.push({ name: host.nameOrRole || '', email: host.email, role: 'host' });
    }
  }
  if (meeting.recruiter?.email || meeting.recruiter?.name) {
    people.push({
      name: meeting.recruiter.name || '',
      email: meeting.recruiter.email || '',
      role: 'recruiter',
    });
  }
  // De-duplicate on email: a recruiter is often also a host.
  const seen = new Set();
  return people.filter((p) => {
    const key = String(p.email || p.name).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Roll the rounds up into the figures the panel header shows.
 *
 * The average covers scored, non-legacy evaluations only — legacy rows have no weighted
 * score, and counting them as 0 would understate every candidate interviewed before the
 * weighted rubric existed.
 *
 * @param {Array<{interviewResult?: string, evaluations?: Array<object>}>} rounds
 * @returns {{roundCount: number, decidedCount: number, evaluationCount: number, averageWeightedScore: number|null}}
 */
export const summariseRounds = (rounds) => {
  const list = Array.isArray(rounds) ? rounds : [];
  let decidedCount = 0;
  let evaluationCount = 0;
  const scores = [];

  for (const round of list) {
    if (round?.interviewResult && round.interviewResult !== 'pending') decidedCount += 1;
    for (const evaluation of round?.evaluations || []) {
      if (evaluation?.isLegacy) continue;
      evaluationCount += 1;
      if (Number.isFinite(evaluation?.weightedScore)) scores.push(evaluation.weightedScore);
    }
  }

  const averageWeightedScore = scores.length
    ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1))
    : null;

  return { roundCount: list.length, decidedCount, evaluationCount, averageWeightedScore };
};

/** Attach each rating's label and weight from the round's criteria, for display. */
const decorateRatings = (criteria, ratings) => {
  const byKey = new Map((criteria || []).map((c) => [c.key, c]));
  return (ratings || []).map((r) => {
    const criterion = byKey.get(r.key);
    return {
      key: r.key,
      label: criterion?.label || r.key,
      weight: criterion?.weight ?? null,
      rating: r.rating ?? null,
      notApplicable: Boolean(r.notApplicable),
    };
  });
};

/**
 * Every round of one application, in round order, with every evaluation attached.
 *
 * Visibility reuses meetingScope, so this endpoint can never show a round the caller
 * could not already see in the Interviews list.
 *
 * Ceiling: no pagination. An application with hundreds of rounds would return them all;
 * a real hiring process has single digits. Add a limit here if that ever changes.
 *
 * @param {string} applicationId
 * @param {object} currentUser
 * @returns {Promise<{applicationId: string, summary: object, rounds: Array<object>}>}
 */
export const getRoundHistoryForApplication = async (applicationId, currentUser) => {
  if (!applicationId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'applicationId is required');
  }

  const { filter: scope } = await meetingScope(currentUser, 'read');
  const meetings = await Meeting.find({ $and: [{ applicationId }, scope] })
    .sort({ 'round.index': 1, scheduledAt: 1 })
    .populate({ path: 'interviewScorecard.scoredBy', select: 'name email' })
    .lean();

  const evaluationsByMeeting = await listEvaluationsForMeetings(meetings.map((m) => m._id));

  const rounds = meetings.map((meeting) => {
    const criteria = criteriaForMeeting(meeting);
    const stored = (evaluationsByMeeting.get(String(meeting._id)) || []).map((row) => ({
      id: String(row._id),
      evaluatorName: row.evaluatorName || '',
      evaluatorEmail: row.evaluatorEmail || '',
      weightedScore: row.weightedScore ?? null,
      coveragePct: row.coveragePct ?? 0,
      scoredCount: row.scoredCount ?? 0,
      totalCount: row.totalCount ?? 0,
      isComplete: Boolean(row.isComplete),
      comment: row.comment || '',
      ratings: decorateRatings(criteria, row.ratings),
      submittedAt: row.submittedAt || null,
      isLegacy: false,
    }));

    const legacy = legacyScorecardAsEvaluation(meeting);
    if (legacy) stored.push(legacy);

    return {
      id: String(meeting._id),
      meetingId: meeting.meetingId,
      round: meeting.round || null,
      roundName: buildRoundName(meeting.round),
      title: meeting.title || '',
      scheduledAt: meeting.scheduledAt || null,
      timezone: meeting.timezone || 'UTC',
      durationMinutes: meeting.durationMinutes ?? null,
      interviewType: meeting.interviewType || '',
      status: meeting.status || 'scheduled',
      interviewResult: meeting.interviewResult || 'pending',
      interviewers: interviewersFor(meeting),
      rubric: {
        templateId: meeting.rubricSnapshot?.templateId || null,
        templateName: meeting.rubricSnapshot?.templateName || 'Default rubric',
        criteria,
      },
      evaluations: stored,
    };
  });

  return { applicationId: String(applicationId), summary: summariseRounds(rounds), rounds };
};
