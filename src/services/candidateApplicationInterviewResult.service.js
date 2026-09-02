import Meeting from '../models/meeting.model.js';
import { buildLatestInterviewResultMap } from '../utils/candidateApplicationInterviewResult.js';

/**
 * Batched lookup: one Meeting query for all applications on the current page.
 * @param {object[]} applications - paginated JobApplication docs (candidate + job populated)
 * @returns {Promise<Map<string, string|null>>} applicationId → interviewResult | null
 */
export const loadInterviewResultsForApplications = async (applications) => {
  const rows = applications || [];
  if (!rows.length) return new Map();

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
    return new Map(
      rows.map((app) => [String(app.id || app._id), null])
    );
  }

  const meetings = await Meeting.find({
    'candidate.id': { $in: candidateIds },
    status: { $ne: 'cancelled' },
  })
    .select('candidate.id jobPosition interviewResult scheduledAt createdAt updatedAt status')
    .lean();

  return buildLatestInterviewResultMap(rows, meetings);
};
