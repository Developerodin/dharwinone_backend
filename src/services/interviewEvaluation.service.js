import httpStatus from 'http-status';
import InterviewEvaluation from '../models/interviewEvaluation.model.js';
import ApiError from '../utils/ApiError.js';
import { computeWeightedScore } from '../utils/interviewScore.js';
import { DEFAULT_RUBRIC_CRITERIA } from '../constants/interviewRubric.js';

/**
 * The criteria a round is scored against.
 *
 * Always the round's own snapshot. Rounds scheduled before rubricSnapshot existed fall
 * back to the built-in default so they stay scorable — deliberately NOT a fresh template
 * resolution, which would score an old round against today's rubric.
 *
 * @param {object|null} meeting
 * @returns {Array<{key: string, label: string, weight: number, scaleMin: number, scaleMax: number}>}
 */
export const criteriaForMeeting = (meeting) => {
  const snapshot = meeting?.rubricSnapshot?.criteria;
  if (Array.isArray(snapshot) && snapshot.length) {
    return snapshot.map((c) => ({
      key: String(c.key),
      label: String(c.label || c.key),
      weight: Number(c.weight),
      scaleMin: Number(c.scaleMin ?? 1),
      scaleMax: Number(c.scaleMax ?? 5),
    }));
  }
  return DEFAULT_RUBRIC_CRITERIA.map((c) => ({ ...c }));
};

/**
 * Normalise submitted ratings against the round's criteria.
 *
 * A key absent from the criteria is dropped rather than stored, so a stale client cannot
 * plant ratings for a criterion this round was never scored on. Each rating is clamped to
 * ITS OWN criterion's scale — criteria may declare different scales.
 *
 * `notApplicable` wins over a rating: the two cannot both be true of one criterion, and
 * silently keeping the number would make the stored row contradict itself.
 *
 * @param {Array<object>} criteria
 * @param {Array<{key: string, rating?: number|null, notApplicable?: boolean}>} ratings
 * @returns {Array<{key: string, rating: number|null, notApplicable: boolean}>}
 */
export const sanitizeRatings = (criteria, ratings) => {
  const criteriaList = Array.isArray(criteria) ? criteria : [];
  const submitted = Array.isArray(ratings) ? ratings : [];
  if (!criteriaList.length || !submitted.length) return [];

  const byKey = new Map(criteriaList.map((c) => [String(c.key), c]));
  const result = new Map(); // last entry for a key wins

  for (const entry of submitted) {
    const key = String(entry?.key || '');
    const criterion = byKey.get(key);
    if (!criterion) continue;

    if (entry?.notApplicable) {
      result.set(key, { key, rating: null, notApplicable: true });
      continue;
    }

    if (entry?.rating == null || entry?.rating === '') {
      result.set(key, { key, rating: null, notApplicable: false });
      continue;
    }

    const raw = Number(entry.rating);
    if (!Number.isFinite(raw)) {
      result.set(key, { key, rating: null, notApplicable: false });
      continue;
    }

    const scaleMin = Number(criterion.scaleMin ?? 1);
    const scaleMax = Number(criterion.scaleMax ?? 5);
    result.set(key, {
      key,
      rating: Math.min(Math.max(raw, scaleMin), scaleMax),
      notApplicable: false,
    });
  }

  return [...result.values()];
};

/**
 * Create or update the CALLING USER'S evaluation of a round.
 *
 * The evaluator comes from the authenticated user, never from the body, so one person
 * cannot submit or overwrite another's evaluation (audit R7). The upsert filter is
 * (meeting, evaluator), which is also the collection's unique index — so a double-submit
 * updates one row instead of racing two inserts.
 *
 * @param {{meeting: object, user: object, ratings: Array<object>, comment: string}} input
 * @returns {Promise<object>} the stored evaluation
 */
export const saveEvaluation = async ({ meeting, user, ratings, comment }) => {
  const evaluatorId = user?._id || user?.id;
  if (!evaluatorId) throw new ApiError(httpStatus.UNAUTHORIZED, 'Sign in to record an evaluation');
  if (!meeting?._id) throw new ApiError(httpStatus.NOT_FOUND, 'Interview not found');

  const criteria = criteriaForMeeting(meeting);
  const cleanRatings = sanitizeRatings(criteria, ratings);
  const score = computeWeightedScore(criteria, cleanRatings);

  const update = {
    $set: {
      applicationId: meeting.applicationId || null,
      evaluatorName: user.name || '',
      evaluatorEmail: user.email || '',
      rubricTemplateId: meeting.rubricSnapshot?.templateId || null,
      rubricTemplateName: meeting.rubricSnapshot?.templateName || '',
      ratings: cleanRatings,
      comment: String(comment || '').trim(),
      weightedScore: score.weightedScore,
      coveragePct: score.coveragePct,
      scoredCount: score.scoredCount,
      totalCount: score.totalCount,
      isComplete: score.isComplete,
      submittedAt: new Date(),
      tenantId: meeting.tenantId || null,
    },
  };

  return InterviewEvaluation.findOneAndUpdate(
    { meeting: meeting._id, evaluator: evaluatorId },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

/** The caller's own evaluation, for pre-filling the form. Null when they have not scored yet. */
export const getMyEvaluation = async (meetingId, userId) =>
  InterviewEvaluation.findOne({ meeting: meetingId, evaluator: userId });

/**
 * Every evaluation for a set of rounds, grouped by round.
 *
 * One query for the whole page rather than one per round — the history panel renders
 * every round of an application at once.
 *
 * @param {Array<string>} meetingIds
 * @returns {Promise<Map<string, Array<object>>>} meetingId → evaluations, oldest first
 */
export const listEvaluationsForMeetings = async (meetingIds) => {
  const ids = (meetingIds || []).filter(Boolean);
  const grouped = new Map(ids.map((id) => [String(id), []]));
  if (!ids.length) return grouped;

  const rows = await InterviewEvaluation.find({ meeting: { $in: ids } })
    .sort({ submittedAt: 1 })
    .lean();

  for (const row of rows) {
    const key = String(row.meeting);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
};
