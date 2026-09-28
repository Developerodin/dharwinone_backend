import JobModel from '../../../../../models/job.model.js';
import { mapJobRow } from '../../../jobResult.js';
import { resolveJobVisibilityFilter } from '../../../queryPlanner/entities/jobRank.js';

export const JOBS_ACCESS = Object.freeze({ anyOf: ['jobs.read'] });

/**
 * The Job model and the caller's Jobs-page visibility clause for one tool call.
 * Every job tool ANDs `visibilityFilter` into each query it runs, so Sage never sees
 * more jobs than the ATS Jobs page shows this user. `ctx.deps` swaps either in tests.
 * Throws without a user id: buildJobListFilter returns {} (unrestricted) when it has no
 * userId, so a missing id must fail closed, not widen visibility. The registry turns the
 * throw into a tool error.
 * @param {{ user: object, deps?: { Job?: object, resolveJobVisibilityFilter?: Function } }} ctx
 */
export async function jobScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('job tools need an authenticated user with an id');
  }
  const deps = ctx.deps || {};
  const resolveVisibility = deps.resolveJobVisibilityFilter ?? resolveJobVisibilityFilter;
  return {
    Job: deps.Job ?? JobModel,
    visibilityFilter: await resolveVisibility(ctx.user),
  };
}

/**
 * Compact list row for the model: mapJobRow's field names (so renderJobResult can
 * draw it) minus the heavy fields — description, skill requirements, external refs.
 * Full detail is get_job's job.
 * @param {object} doc - a lean Job document, or a row mapJobRow already built
 */
export function jobRow(doc) {
  const r = doc.jobId ? doc : mapJobRow(doc);
  return {
    jobId: r.jobId,
    jobUrl: r.jobUrl,
    title: r.title,
    organisation: r.organisation?.name ? { name: r.organisation.name } : null,
    jobType: r.jobType,
    location: r.location,
    status: r.status,
    experienceLevel: r.experienceLevel,
    salaryRange: r.salaryRange ?? null,
    skillTags: r.skillTags,
    vacancies: r.vacancies,
    applicationDeadline: r.applicationDeadline,
    createdAt: r.createdAt,
    jobOrigin: r.jobOrigin,
  };
}

/**
 * Count facts for enforceCounts (responseValidator.js), which rewrites any "N jobs"
 * in the reply to `total`. Only emit this when `total` is the one number the reply
 * reports — a per-group breakdown ("Full-time: 9 jobs") would get rewritten to it.
 * @param {string} kind - tool name
 * @param {number} total
 */
export function jobCountFacts(kind, total) {
  const fact = { kind, label: 'jobs', total };
  return { counts: [fact], primary: fact };
}
