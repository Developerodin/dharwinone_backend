/**
 * Atomic job query — single source of truth for count + list in Sage job replies.
 * Count and rows always come from one Mongo query with identical filters.
 */

import crypto from 'crypto';
import Job from '../../models/job.model.js';
import { buildJobRankingMongoFilter } from './queryPlanner/entities/jobRank.js';

const JOB_SELECT =
  'title jobType location status salaryRange experienceLevel skillTags organisation jobOrigin externalRef externalPlatformUrl jobDescription createdAt';

/** @param {object} row */
export function mapJobRow(row) {
  const origin = row.jobOrigin || 'internal';
  return {
    jobId: String(row._id || row.id || row.jobId || ''),
    title: row.title,
    jobType: row.jobType,
    location: row.location,
    status: row.status,
    experienceLevel: row.experienceLevel,
    salaryRange: row.salaryRange,
    organisation: row.organisation,
    skillTags: row.skillTags || [],
    jobOrigin: origin,
    _origin: origin === 'external' ? 'External (mirrored)' : 'Internal',
    externalPlatformUrl: row.externalPlatformUrl || null,
    jobDescription: row.jobDescription || null,
  };
}

/** @param {object} filters */
export function hashJobFilters(filters) {
  const stable = JSON.stringify(filters, Object.keys(filters).sort());
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * @param {object} job
 * @param {string|null} jobOriginFilter
 */
export function jobMatchesOrigin(job, jobOriginFilter) {
  if (!jobOriginFilter) return true;
  const origin = job.jobOrigin || 'internal';
  if (jobOriginFilter === 'external') return origin === 'external';
  if (jobOriginFilter === 'internal') return origin !== 'external';
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
      ? JobModel.find(mongoFilter).select(JOB_SELECT).sort({ createdAt: -1 }).limit(queryLimit).lean()
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

/**
 * @param {object|null} fetched
 */
export function resolveJobPayload(fetched) {
  if (!fetched) return null;
  if (fetched.job_result) return fetched.job_result;
  if (fetched.fetch_jobs?.type === 'job_result') return fetched.fetch_jobs;
  if (fetched.fetch_jobs) {
    const data = fetched.fetch_jobs;
    const filters = data.query?.filters ?? data.filters ?? {};
    const total = Number(
      data.result?.total
      ?? data.authoritativeCount
      ?? data.counts?.total
      ?? data.total
      ?? data.records?.length
      ?? 0,
    );
    const records = data.result?.jobs ?? data.records ?? [];
    return buildJobResultEnvelope({
      filters,
      total,
      records,
      intent: data.intent ?? (records.length ? 'list' : 'count'),
      queryId: data.query?.queryId ?? data.queryId ?? null,
    });
  }
  return null;
}

/** @param {object} filters @param {number} total */
export function buildJobCountPhrase(filters = {}, total = 0) {
  const parts = [];
  if (filters.status) parts.push(String(filters.status).toLowerCase());
  const origin = originLabelFromFilters(filters);
  if (origin) parts.push(origin.toLowerCase());
  parts.push(total === 1 ? 'job' : 'jobs');
  return parts.join(' ');
}
