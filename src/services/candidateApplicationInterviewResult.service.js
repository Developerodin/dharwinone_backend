import Meeting from '../models/meeting.model.js';
import {
  buildLatestInterviewResultMap,
  buildApplicationInterviewsByAppId,
  CANDIDATE_INTERVIEW_MEETING_SELECT,
} from '../utils/candidateApplicationInterviewResult.js';

const emptyMapsForRows = (rows) => {
  const interviewResultByAppId = new Map(rows.map((app) => [String(app.id || app._id), null]));
  const interviewsByAppId = new Map(rows.map((app) => [String(app.id || app._id), []]));
  return { interviewResultByAppId, interviewsByAppId };
};

/**
 * Batched lookup: one Meeting query for all applications on the current page.
 * @param {object[]} applications - paginated JobApplication docs (candidate + job populated)
 * @returns {Promise<{ interviewResultByAppId: Map<string, string|null>, interviewsByAppId: Map<string, object[]> }>}
 */
export const loadCandidateInterviewDataForApplications = async (applications) => {
  const rows = applications || [];
  if (!rows.length) {
    return { interviewResultByAppId: new Map(), interviewsByAppId: new Map() };
  }

  const candidateIds = [
    ...new Set(
      rows
        .map((app) => {
          const c = app.candidate;
          return String(c?._id || c?.id || c || '');
        })
        .filter(Boolean)
    ),
  ];

  if (!candidateIds.length) {
    return emptyMapsForRows(rows);
  }

  const meetings = await Meeting.find({
    'candidate.id': { $in: candidateIds },
  })
    .select(CANDIDATE_INTERVIEW_MEETING_SELECT)
    .lean();

  return {
    interviewResultByAppId: buildLatestInterviewResultMap(rows, meetings),
    interviewsByAppId: buildApplicationInterviewsByAppId(rows, meetings),
  };
};

/**
 * @param {object[]} applications
 * @returns {Promise<Map<string, string|null>>} applicationId → interviewResult | null
 */
export const loadInterviewResultsForApplications = async (applications) => {
  const { interviewResultByAppId } = await loadCandidateInterviewDataForApplications(applications);
  return interviewResultByAppId;
};
