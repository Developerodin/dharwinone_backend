import Job from '../../../models/job.model.js';
import { mapJobRow } from '../jobResult.js';

const JOB_PROFILE_SELECT =
  'title jobType location status salaryRange experienceLevel minExperience maxExperience skillTags skillRequirements organisation jobOrigin externalPlatformUrl jobDescription vacancies createdAt';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[\s,._-]+/).filter(Boolean);
}

function scoreTitleMatch(query, doc) {
  const q = String(query || '').trim().toLowerCase();
  const title = String(doc?.title || '').trim().toLowerCase();
  if (!q || !title) return 0;
  if (title === q) return 1;
  if (title.includes(q) || q.includes(title)) return 0.9;

  const qTokens = tokenize(q);
  const tTokens = tokenize(title);
  if (!qTokens.length || !tTokens.length) return 0;

  let hits = 0;
  for (const qt of qTokens) {
    if (tTokens.some((tt) => tt === qt || tt.startsWith(qt) || qt.startsWith(tt))) hits += 1;
  }
  return hits / qTokens.length >= 0.6 ? hits / qTokens.length * 0.85 : 0;
}

/**
 * Resolve a job by partial title — unique, ambiguous, or not found.
 *
 * @param {string} query
 * @param {{ Job?: import('mongoose').Model, limit?: number, status?: string|null }} [opts]
 */
export async function resolveJobByTitle(query, opts = {}) {
  const JobModel = opts.Job ?? Job;
  const trimmed = String(query || '').trim();
  if (!trimmed) return { kind: 'notFound', query: trimmed };

  const mongoFilter = {
    title: { $regex: escapeRegex(trimmed), $options: 'i' },
  };
  if (opts.status) mongoFilter.status = opts.status;

  const docs = await JobModel.find(mongoFilter)
    .select(JOB_PROFILE_SELECT)
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 6)
    .lean();

  if (!docs.length) return { kind: 'notFound', query: trimmed };

  const scored = docs
    .map((d) => ({ doc: d, score: scoreTitleMatch(trimmed, d) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: 'notFound', query: trimmed };

  const top = scored[0];
  const second = scored[1];
  if (scored.length === 1 || (second && top.score - second.score >= 0.15)) {
    return {
      kind: 'unique',
      query: trimmed,
      job: mapJobRow(top.doc),
      raw: top.doc,
    };
  }

  return {
    kind: 'ambiguous',
    query: trimmed,
    matches: scored.slice(0, 5).map(({ doc, score }) => ({
      jobId: String(doc._id),
      title: doc.title,
      company: doc.organisation?.name ?? null,
      location: doc.location ?? null,
      score,
    })),
  };
}

/**
 * Fetch one job by id for follow-up turns.
 * @param {string} jobId
 * @param {{ Job?: import('mongoose').Model }} [opts]
 */
export async function fetchJobById(jobId, opts = {}) {
  const JobModel = opts.Job ?? Job;
  const doc = await JobModel.findById(jobId).select(JOB_PROFILE_SELECT).lean();
  if (!doc) return null;
  return { job: mapJobRow(doc), raw: doc };
}
