/**
 * Atomic job query — single source of truth for count + list in Sage job replies.
 * Count and rows always come from one Mongo query with identical filters.
 */

import crypto from 'crypto';
import Job from '../../models/job.model.js';
import config from '../../config/config.js';
import { buildJobRankingMongoFilter } from './queryPlanner/entities/jobRank.js';
import { htmlToReadable } from './htmlText.js';

const JOB_SELECT =
  'title jobType location status salaryRange experienceLevel minExperience maxExperience skillTags skillRequirements organisation jobOrigin externalRef externalPlatformUrl jobDescription vacancies applicationDeadline createdAt assignedRecruiter';

// Frontend job detail deep-link. `/ats/jobs` (the recruiter-facing list) opens
// its JobPreviewPanel from a `?view=<jobId>` query param — see the "Deep-link"
// effect in uat.dharwin.frontend app/(components)/(contentlayout)/ats/jobs/page.tsx.
// There is no separate single-job "view" route to link to instead.
const FRONTEND_BASE_URL = String(config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '');

/** @param {string|null} jobId */
export function buildJobPageUrl(jobId) {
  if (!jobId) return null;
  return `${FRONTEND_BASE_URL}/ats/jobs?view=${encodeURIComponent(jobId)}`;
}

/** @param {object} row */
export function mapJobRow(row) {
  const origin = row.jobOrigin || 'internal';
  const jobId = String(row._id || row.id || row.jobId || '');
  const recruiter = row.assignedRecruiter;
  const recruiterName =
    recruiter && typeof recruiter === 'object' && recruiter.name ? recruiter.name : null;
  return {
    jobId,
    jobUrl: buildJobPageUrl(jobId),
    title: row.title,
    jobType: row.jobType,
    location: row.location,
    status: row.status,
    experienceLevel: row.experienceLevel,
    minExperience: row.minExperience ?? null,
    maxExperience: row.maxExperience ?? null,
    salaryRange: row.salaryRange,
    organisation: row.organisation,
    skillTags: row.skillTags || [],
    skillRequirements: row.skillRequirements || [],
    vacancies: row.vacancies ?? null,
    applicationDeadline: row.applicationDeadline || null,
    createdAt: row.createdAt || null,
    jobOrigin: origin,
    _origin: origin === 'external' ? 'External (mirrored)' : 'Internal',
    externalPlatformUrl: row.externalPlatformUrl || null,
    externalRef: row.externalRef || null,
    jobDescription: htmlToReadable(row.jobDescription) || null,
    recruiterName,
  };
}

/** @param {object} filters */
export function hashJobFilters(filters) {
  const stable = JSON.stringify(filters, Object.keys(filters).sort());
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * JS-side mirror of job.service.js's MIRROR_EXTERNAL_OR — same "external" definition
 * (jobOrigin==='external' OR a legacy externalRef-only row), for an already-loaded job
 * object instead of a Mongo query. A plain `jobOrigin !== 'external'` check for "internal"
 * isn't the true complement — a legacy row with jobOrigin unset but a populated externalRef
 * is external by MIRROR_EXTERNAL_OR's own definition, and would otherwise double-count.
 * @param {object} job
 * @returns {boolean}
 */
function isMirroredExternal(job) {
  if (job?.jobOrigin === 'external') return true;
  const ref = job?.externalRef;
  return !!(ref && ref.externalId != null && ref.externalId !== '' && ref.source != null && ref.source !== '');
}

/**
 * @param {object} job
 * @param {string|null} jobOriginFilter
 */
export function jobMatchesOrigin(job, jobOriginFilter) {
  if (!jobOriginFilter) return true;
  const external = isMirroredExternal(job);
  if (jobOriginFilter === 'external') return external;
  if (jobOriginFilter === 'internal') return !external;
  return true;
}

/** @param {object} filters */
export function originLabelFromFilters(filters = {}) {
  if (filters.jobOrigin === 'external') return 'External';
  if (filters.jobOrigin === 'internal') return 'Internal';
  return null;
}

/**
 * @param {{ filters?: object, total: number, records?: object[], intent?: string, queryId?: string }} input
 */
export function buildJobResultEnvelope({
  filters = {},
  total,
  records = [],
  intent = 'count',
  queryId = null,
}) {
  const id = queryId || hashJobFilters(filters);
  const jobs = records.map((r) => (r.jobId ? r : mapJobRow(r)));
  return {
    type: 'job_result',
    query: {
      entity: 'job',
      filters: { ...filters },
      queryId: id,
    },
    result: {
      total,
      jobs,
    },
    intent,
    records,
    rows: jobs,
    total,
    queryId: id,
    filters: { ...filters },
    label: 'job',
    provenance: 'Job.countDocuments+find',
    authoritative: true,
    authoritativeCount: total,
  };
}

/**
 * @param {object|null} payload
 * @param {number|null} [proseCount]
 */
export function assertJobResultIntegrity(payload, proseCount = null) {
  if (!payload) return { ok: true, issues: [] };
  const issues = [];
  const total = Number(
    payload?.result?.total
    ?? payload?.authoritativeCount
    ?? payload?.total
    ?? NaN,
  );
  const jobs = payload?.result?.jobs
    ?? payload?.rows
    ?? payload?.records?.map((r) => (r.jobId ? r : mapJobRow(r)))
    ?? [];
  const filters = payload?.query?.filters ?? payload?.filters ?? {};

  if (!Number.isFinite(total)) {
    issues.push('job_result missing authoritative total');
  } else if (jobs.length > total) {
    issues.push(`job_result rows (${jobs.length}) exceed total (${total})`);
  }

  if (filters.status) {
    for (const j of jobs) {
      if (j.status && j.status !== filters.status) {
        issues.push(`job "${j.title || j.jobId}" status=${j.status} != filter ${filters.status}`);
        break;
      }
    }
  }

  if (filters.jobOrigin) {
    for (const j of jobs) {
      if (!jobMatchesOrigin(j, filters.jobOrigin)) {
        issues.push(`job "${j.title || j.jobId}" origin=${j.jobOrigin} != filter ${filters.jobOrigin}`);
        break;
      }
    }
  }

  if (proseCount != null && Number.isFinite(total) && proseCount !== total) {
    issues.push(`prose count (${proseCount}) != result.total (${total})`);
  }

  if (issues.length) {
    const err = new Error(`job_result integrity: ${issues.join('; ')}`);
    err.issues = issues;
    throw err;
  }
  return { ok: true, issues: [] };
}

/**
 * Single atomic job query — count and list from identical filters.
 * @param {{ filters?: object, limit?: number, listIntent?: boolean, queryId?: string }} [options]
 */
export async function executeAtomicJobQuery(options = {}) {
  const {
    filters: inputFilters = {},
    limit = 50,
    listIntent = false,
    queryId = null,
    JobModel = Job,
  } = options;

  const filters = { ...inputFilters };
  const mongoFilter = buildJobRankingMongoFilter({ filters });
  const queryLimit = listIntent ? Math.min(Math.max(Number(limit) || 50, 1), 200) : 0;

  const [total, docs] = await Promise.all([
    JobModel.countDocuments(mongoFilter),
    queryLimit > 0
      ? JobModel.find(mongoFilter)
          .select(JOB_SELECT)
          .populate({ path: 'assignedRecruiter', select: 'name' })
          .sort({ createdAt: -1 })
          .limit(queryLimit)
          .lean()
      : Promise.resolve([]),
  ]);

  const records = docs.map(mapJobRow);
  const envelope = buildJobResultEnvelope({
    filters,
    total,
    records,
    intent: listIntent ? 'list' : 'count',
    queryId,
  });
  assertJobResultIntegrity(envelope);
  return envelope;
}

/** @param {object} filters @param {number} total */
export function buildJobCountPhrase(filters = {}, total = 0) {
  const parts = [];
  // status:'all' means the user explicitly asked for every status — named as a suffix
  // below instead of here, so it doesn't read as "all jobs" (ambiguous with jobType/count).
  if (filters.status && filters.status !== 'all') parts.push(String(filters.status).toLowerCase());
  if (filters.remote) parts.push('remote');
  const origin = originLabelFromFilters(filters);
  if (origin) parts.push(origin.toLowerCase());
  // Names what was actually counted, e.g. "active remote AI jobs" — a topic search term
  // (jobFilter.js extractJobTopicKeyword) must show up in the reply, not just the total.
  if (filters.search) parts.push([].concat(filters.search).map((t) => String(t).trim()).join(' or '));
  parts.push(total === 1 ? 'job' : 'jobs');
  if (filters.skill) parts.push(`with ${String(filters.skill).trim()}`);
  if (filters.company) parts.push(`at ${String(filters.company).trim()}`);
  if (filters.city) parts.push(`in ${String(filters.city).trim()}`);
  if (filters.status === 'all') parts.push('across all statuses');
  return parts.join(' ');
}
