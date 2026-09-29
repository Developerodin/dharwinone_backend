import { JOB_SALARY_SORT_FIELD } from '../../../../schemas/queryOperations.js';
import {
  buildJobListFilter,
  buildJobSearchClause,
  applyJobListFacetFilters,
  applyJobSalaryQueryFilters,
  applyJobExperienceQueryFilters,
  applyPostingDateFilter,
  MIRROR_EXTERNAL_OR,
} from '../../../job.service.js';
import { buildLocationFilterClause } from '../../../../utils/jobLocation.util.js';

/** Matches jobs with no meaningful salary (same semantics as ATS "Not specified"). */
const SALARY_NOT_SPECIFIED_CLAUSE = {
  $or: [
    { salaryRange: { $exists: false } },
    { salaryRange: null },
    {
      $and: [
        { $or: [{ 'salaryRange.min': { $exists: false } }, { 'salaryRange.min': null }] },
        { $or: [{ 'salaryRange.max': { $exists: false } }, { 'salaryRange.max': null }] },
      ],
    },
    { $and: [{ 'salaryRange.min': 0 }, { 'salaryRange.max': 0 }] },
  ],
};

const JOB_SELECT =
  'title jobType location status salaryRange experienceLevel skillTags organisation jobOrigin externalRef externalPlatformUrl jobDescription createdAt';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Job.status enum (job.model.js) keyed by lowercased common phrasing. */
const STATUS_ALIASES = {
  draft: 'Draft',
  active: 'Active',
  open: 'Active',
  live: 'Active',
  closed: 'Closed',
  filled: 'Closed',
  archived: 'Archived',
};

/** Job.jobType enum (job.model.js) keyed by lowercased, whitespace/hyphen-stripped phrasing. */
const JOB_TYPE_ALIASES = {
  fulltime: 'Full-time',
  parttime: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  temp: 'Temporary',
  internship: 'Internship',
  intern: 'Internship',
  freelance: 'Freelance',
};

/** @param {string} value @returns {string|null} canonical Job.status, or null if unrecognized */
function normalizeStatus(value) {
  if (!value) return null;
  return STATUS_ALIASES[String(value).trim().toLowerCase()] || null;
}

/** @param {string} value @returns {string|null} canonical Job.jobType, or null if unrecognized */
function normalizeJobType(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '');
  return JOB_TYPE_ALIASES[key] || null;
}

/**
 * Sage's job visibility must match the ATS Jobs page (job.service.js buildJobListFilter):
 * non-privileged users see only their own internal jobs + external mirrors. Reused here
 * — not re-implemented — so Sage can never see more than the page does.
 * @param {{ roleIds?: any[], id?: string, _id?: string, platformSuperUser?: boolean }|null} user
 * @returns {Promise<object>} Mongo clause to AND into every job query ({} = unrestricted)
 */
export async function resolveJobVisibilityFilter(user) {
  return buildJobListFilter({
    userRoleIds: user?.roleIds || [],
    userId: user?.id || user?._id,
    platformSuperUser: user?.platformSuperUser,
    // Every chat message that touches jobs calls this — unlike the Jobs page HTTP route,
    // it has no reason to run the mirror-repair side effect (updateMany + ExternalJob
    // sync) inline on each call.
    skipMirrorRepair: true,
  });
}

/** AND two Mongo filter clauses together; an empty `{}` on either side is a no-op. */
export function andMongoFilters(a = {}, b = {}) {
  const aEmpty = !a || Object.keys(a).length === 0;
  const bEmpty = !b || Object.keys(b).length === 0;
  if (aEmpty && bEmpty) return {};
  if (aEmpty) return b;
  if (bEmpty) return a;
  return { $and: [a, b] };
}

/**
 * Wrap a Job-like model so every countDocuments/find call ANDs in a visibility filter —
 * lets callers that build and own their Mongo filter internally (e.g. jobResult.js's
 * executeAtomicJobQuery) stay scoped without threading the filter through their own args.
 * @param {import('mongoose').Model} JobModel
 * @param {object} visibilityFilter - {} = unrestricted (returns JobModel unwrapped)
 */
export function scopeJobModel(JobModel, visibilityFilter) {
  if (!visibilityFilter || Object.keys(visibilityFilter).length === 0) return JobModel;
  return {
    countDocuments: (filter) => JobModel.countDocuments(andMongoFilters(filter, visibilityFilter)),
    find: (filter) => JobModel.find(andMongoFilters(filter, visibilityFilter)),
  };
}

/**
 * True internal/external split via two scoped countDocuments over the same base filter —
 * a single total can't be un-mixed after the fact once no jobOrigin filter narrowed it.
 * "External" matches the ATS Jobs page's own definition (job.service.js MIRROR_EXTERNAL_OR):
 * jobOrigin 'external' OR a legacy externalRef-only row.
 */
export async function computeJobOriginCounts(JobModel, baseFilterWithoutOrigin) {
  // Strict partition: external = MIRROR_EXTERNAL_OR, internal = NOT that — so the two
  // always sum to the total. { jobOrigin: { $ne: 'external' } } was NOT the complement
  // of MIRROR_EXTERNAL_OR (a legacy row with jobOrigin!=='external' but a populated
  // externalRef matched both filters, double-counting it).
  const externalFilter = andMongoFilters(baseFilterWithoutOrigin, MIRROR_EXTERNAL_OR);
  const internalFilter = andMongoFilters(baseFilterWithoutOrigin, { $nor: [MIRROR_EXTERNAL_OR] });
  const [internal, external] = await Promise.all([
    JobModel.countDocuments(internalFilter),
    JobModel.countDocuments(externalFilter),
  ]);
  return { internal, external, externalListings: external, externalMirrored: external, total: internal + external };
}

/**
 * Sage's own Mongo filter builder. Fields the ATS Jobs page also exposes (status, jobType,
 * jobOrigin, location, experienceMin/Max, salaryMin/Max/NotSpecified, postingDate,
 * titles/companies/locations, search) reuse job.service.js's own clause-building helpers —
 * the same functions buildJobListFilter calls — so a filter value produces the identical
 * Mongo query whether it came from the Jobs page or a chatbot request, and Sage's counts
 * can never drift from what the page itself would show. `remote`, `skill`, `company`
 * (free-text substring) and `department` are Sage-only extras the Jobs page has no
 * equivalent for, so they stay as local clauses ANDed on top.
 * @param {object} plan
 * @returns {object}
 */
export function buildJobRankingMongoFilter(plan) {
  const filter = {};
  const f = plan.filters || {};

  if (f.status === 'all') {
    // no status filter — matches buildJobListFilter's 'all' handling
  } else if (f.status) {
    const normalized = normalizeStatus(f.status);
    filter.status = normalized || { $regex: `^${escapeRegex(f.status)}$`, $options: 'i' };
  }
  if (f.jobType) {
    const normalized = normalizeJobType(f.jobType);
    filter.jobType = normalized || { $regex: `^${escapeRegex(f.jobType)}$`, $options: 'i' };
  }
  if (f.jobOrigin === 'internal') {
    // The true complement of MIRROR_EXTERNAL_OR, not `{ jobOrigin: { $ne: 'external' } }` —
    // that missed the complement for a legacy row with jobOrigin!=='external' but a
    // populated externalRef, which matched MIRROR_EXTERNAL_OR too (same fix already applied
    // in chatAssistant.service.js's computeJobOriginCounts).
    appendFilterClause(filter, { $nor: [MIRROR_EXTERNAL_OR] });
  } else if (f.jobOrigin === 'external') {
    // Same mirror-inclusive definition the Jobs page uses (job.service.js MIRROR_EXTERNAL_OR)
    // — a legacy externalRef-only row with no jobOrigin field set still counts as external.
    appendFilterClause(filter, MIRROR_EXTERNAL_OR);
  }
  // Mirrored listings from one external feed (Job.externalRef.source, e.g. 'linkedin-jobs-api').
  if (f.externalSource) {
    filter['externalRef.source'] = Array.isArray(f.externalSource) ? { $in: f.externalSource } : f.externalSource;
  }
  if (f.company) {
    filter['organisation.name'] = { $regex: escapeRegex(f.company), $options: 'i' };
  }
  if (f.remote) {
    filter.location = { $regex: /remote/i };
  } else if (f.location) {
    const clause = buildLocationFilterClause(f.location);
    if (clause) appendFilterClause(filter, clause);
  } else if (f.city) {
    filter.location = { $regex: escapeRegex(f.city), $options: 'i' };
  }
  if (f.experienceLevel) {
    filter.experienceLevel = { $regex: `^${escapeRegex(f.experienceLevel)}$`, $options: 'i' };
  }
  if (f.skill) {
    const skill = escapeRegex(f.skill);
    appendFilterClause(filter, {
      $or: [
        { skillTags: { $regex: skill, $options: 'i' } },
        { 'skillRequirements.name': { $regex: skill, $options: 'i' } },
      ],
    });
  }
  applyJobListFacetFilters(filter, { titles: f.titles, companies: f.companies, locations: f.locations });
  applyPostingDateFilter(filter, f.postingDate);
  applyJobSalaryQueryFilters(filter, {
    salaryNotSpecified: f.salaryNotSpecified,
    salaryMin: f.salaryMin,
    salaryMax: f.salaryMax,
  });
  applyJobExperienceQueryFilters(filter, {
    experienceMin: f.experienceMin,
    experienceMax: f.experienceMax,
  });
  if (f.department) {
    const dept = escapeRegex(f.department);
    appendFilterClause(filter, {
      $or: [
        { title: { $regex: dept, $options: 'i' } },
        { jobDescription: { $regex: dept, $options: 'i' } },
        { skillTags: { $regex: dept, $options: 'i' } },
      ],
    });
  }
  const searchTerm = f.search || f.title;
  // Several topics ("ml and ai jobs") arrive as an array and match any of them.
  const terms = [].concat(searchTerm || []).map((t) => String(t).trim()).filter(Boolean);
  if (terms.length) {
    // Short topic words ("AI"/"UI"/"QA"/"Go") need word-boundary matching or they match
    // substrings inside unrelated words ("email"/"maintenance"/"quality"/"Google").
    const clauses = terms.map((term) => buildJobSearchClause(term, term.length <= 3));
    appendFilterClause(filter, clauses.length === 1 ? clauses[0] : { $or: clauses });
  }
  // searchAll: every term must match ("react and node jobs", a MERN stack's parts).
  [].concat(f.searchAll || []).map((t) => String(t).trim()).filter(Boolean)
    .forEach((term) => appendFilterClause(filter, buildJobSearchClause(term, term.length <= 3)));

  return filter;
}

function appendFilterClause(filter, clause) {
  if (filter.$and) {
    filter.$and.push(clause);
    return;
  }
  const snapshot = { ...filter };
  Object.keys(filter).forEach((k) => delete filter[k]);
  if (Object.keys(snapshot).length === 0) {
    Object.assign(filter, clause);
    return;
  }
  filter.$and = [snapshot, clause];
}

function buildSalarySpecifiedFilter(baseFilter) {
  const filter = { ...baseFilter };
  appendFilterClause(filter, { $nor: [SALARY_NOT_SPECIFIED_CLAUSE] });
  return filter;
}

function sortSpec(direction) {
  const sign = direction === 'asc' ? 1 : -1;
  return {
    [JOB_SALARY_SORT_FIELD]: sign,
    'salaryRange.min': sign,
    createdAt: -1,
  };
}

/**
 * @param {object} job
 * @returns {string}
 */
export function formatJobSalary(job) {
  const sr = job?.salaryRange;
  if (!sr || typeof sr !== 'object') return 'Not specified';
  const min = sr.min ?? null;
  const max = sr.max ?? null;
  const cur = sr.currency || '';
  if (min == null && max == null) return 'Not specified';
  if (min != null && max != null) return `${cur}${min}–${max}`.trim();
  return `${cur}${min ?? max}`.trim();
}

/**
 * @param {Array<object>} rows
 * @param {number} [startRank=1]
 * @returns {Array<object>}
 */
export function decorateRankedJobRows(rows, startRank = 1) {
  return (rows || []).map((r, i) => ({
    rank: startRank + i,
    ...r,
    salaryLabel: formatJobSalary(r),
  }));
}

/**
 * @param {object} plan
 * @param {{ Job?: import('mongoose').Model, visibilityFilter?: object }} deps
 * @returns {Promise<{ success: boolean, jobs: object[], total: number, plan: object, filters: object }>}
 */
export async function executeJobRank(plan, deps = {}) {
  const Job = deps.Job;
  if (!Job) {
    return { success: false, jobs: [], total: 0, plan, error: 'NO_JOB_MODEL' };
  }

  const baseFilter = buildJobRankingMongoFilter(plan);
  const salaryFilter = buildSalarySpecifiedFilter(baseFilter);
  const filter = andMongoFilters(salaryFilter, deps.visibilityFilter || {});
  const sort = sortSpec(plan.direction ?? 'desc');
  const limit = Math.max(1, plan.limit ?? 1);
  const offset = Math.max(0, plan.offset ?? 0);

  const [total, docs] = await Promise.all([
    Job.countDocuments(filter),
    Job.find(filter).select(JOB_SELECT).sort(sort).skip(offset).limit(limit).lean(),
  ]);

  const jobs = docs.map((d) => ({
    ...d,
    _origin: d.jobOrigin === 'external' ? 'External (mirrored)' : 'Internal',
  }));

  return {
    success: true,
    jobs,
    total,
    plan,
    filters: plan.filters ?? {},
  };
}

