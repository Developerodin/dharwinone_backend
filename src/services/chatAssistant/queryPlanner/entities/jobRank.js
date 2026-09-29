import {
  ENTITY_JOB,
  JOB_SALARY_METRIC,
  JOB_SALARY_SORT_FIELD,
} from '../../../../schemas/queryOperations.js';
import {
  parseRankFollowUp,
  resolveRankDirection,
  resolveRankLimit,
  resolveRankOffset,
  resolveRankOperation,
  RANK_CUE_RE,
  TOP_N_RE,
} from '../rankPlan.js';
import Job from '../../../../models/job.model.js';
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

const JOB_SUBJECT_RE =
  /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?)\b/i;

const SALARY_WORD_RE = /\b(salary|salaries|pay|compensation|package|paid)\b/i;

const SALARY_SUPERLATIVE_RE =
  /\b(highest[\s-]?pay(?:ing)?|top[\s-]?pay(?:ing)?|best[\s-]?pay(?:ing)?|lowest[\s-]?pay(?:ing)?|pays?\s+the\s+most|pay(?:s|ing)\s+the\s+(most|least|highest|lowest))\b/i;

const LIST_JOBS_RE =
  /\b(list( all)? jobs?|show( me)? (all )?jobs?|how many jobs?|total jobs?)\b/i;

/**
 * Words indicating the user wants every status, not just the Sage/Jobs-page default
 * (Active). Mirrors jobFilter.js's JOB_ALL_STATUSES_STRONG_RE — kept as a separate copy
 * here (not imported) because jobFilter.js already imports from this module, and importing
 * back would create a cycle. Keep the two in sync if this changes. Deliberately does NOT
 * include a bare "all" — "list all AI jobs" uses "all" as a generic quantifier, not a
 * request for every status, and must still default to Active.
 */
const JOB_ALL_STATUSES_STRONG_RE =
  /\ball\s+status(?:es)?\b|\bevery\s+status(?:es)?\b|\bany\s+status(?:es)?\b|\bincluding\s+closed\b|\bever\s+posted\b/i;

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
 * Verify a free-text company candidate against real data before treating it as a filter.
 * parseJobFilters' regex over-captures role nouns / locations ("jobs for React devs",
 * "at Bangalore") as a "company" with no way to tell from the regex alone — a substring,
 * case-insensitive match against real Job organisation.name values is the ground truth
 * the regex can't provide. Unanchored to match buildJobRankingMongoFilter's own company
 * clause exactly (`{ $regex: escapeRegex(f.company), $options: 'i' }`, no `^$`) — an
 * anchored exact match here rejected real, verified companies whenever the candidate was
 * a substring of the full legal name ("Acme" vs. "Acme Technologies Pvt Ltd"), silently
 * dropping the filter and returning every job instead of just that company's.
 * @param {string|null|undefined} candidate
 * @param {{ Job?: import('mongoose').Model }} [deps]
 * @returns {Promise<boolean>}
 */
export async function verifyCompanyCandidate(candidate, deps = {}) {
  const JobModel = deps.Job ?? Job;
  const name = String(candidate || '').trim();
  if (!name) return false;
  const exists = await JobModel.exists({
    'organisation.name': { $regex: escapeRegex(name), $options: 'i' },
  });
  return !!exists;
}

/**
 * True when any job's location matches the "in X" capture — i.e. X is a place, not a
 * topic ("jobs in Pune" vs "jobs in AI"). Whole-word, unlike the substring city filter
 * clause, so "ai" doesn't pass as a place because "Mumbai"/"Chennai" contain it.
 * @param {string|null|undefined} candidate
 * @param {{ Job?: import('mongoose').Model }} [deps]
 * @returns {Promise<boolean>}
 */
export async function verifyCityCandidate(candidate, deps = {}) {
  const JobModel = deps.Job ?? Job;
  const city = String(candidate || '').trim();
  if (!city) return false;
  return !!(await JobModel.exists({ location: { $regex: `(?<!\\w)${escapeRegex(city)}(?!\\w)`, $options: 'i' } }));
}

function basePlanFromContext(ctx) {
  return {
    entity: ENTITY_JOB,
    metric: ctx.metric ?? JOB_SALARY_METRIC,
    direction: ctx.direction ?? 'desc',
    filters: { ...(ctx.filters || {}) },
    operation: ctx.operation ?? 'TOP_N',
  };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeJobRankingQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!JOB_SUBJECT_RE.test(t)) return false;
  if (LIST_JOBS_RE.test(t) && !RANK_CUE_RE.test(t)) return false;

  return (
    (SALARY_WORD_RE.test(t) && RANK_CUE_RE.test(t)) ||
    SALARY_SUPERLATIVE_RE.test(t) ||
    (TOP_N_RE.test(t) && /\bpay(?:ing)?\b/i.test(t))
  );
}

/**
 * @param {string} message
 * @param {object|null} ctx
 * @returns {object}
 */
function parseSalaryThreshold(text) {
  const m = String(text || '').match(
    /\b(?:over|above|more than|at least|>=?|minimum|min)\s*\$?\s*(\d+(?:\.\d+)?)\s*(k|K|thousand|l|L|lac|lakh)?\b/i,
  );
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'thousand') n *= 1000;
  else if (unit === 'l' || unit === 'lac' || unit === 'lakh') n *= 100000;
  return Math.round(n);
}

function parseExperienceYears(text) {
  const t = String(text || '').toLowerCase();
  const range = t.match(/\b(\d+)\s*(?:-|to)\s*(\d+)\s*years?\b/);
  if (range) {
    return { experienceMin: Number(range[1]), experienceMax: Number(range[2]) };
  }
  const atLeast = t.match(/\b(?:at least|minimum|min)\s*(\d+)\s*years?\b/);
  if (atLeast) return { experienceMin: Number(atLeast[1]) };
  const upTo = t.match(/\b(?:up to|maximum|max)\s*(\d+)\s*years?\b/);
  if (upTo) return { experienceMax: Number(upTo[1]) };
  const plain = t.match(/\b(\d+)\s*\+?\s*years?\s*(?:of\s+)?experience\b/);
  if (plain) return { experienceMin: Number(plain[1]) };
  return null;
}

function parseSkillFilter(message) {
  const raw = String(message || '');
  const patterns = [
    /\bjobs?\s+(?:require|requiring|needs?|with)\s+([A-Za-z#+.][\w#+.\-/]*)/i,
    /\b(?:require|requiring|needs?|must have|with)\s+([A-Za-z#+.][\w#+.\-/]*)(?:\s+skills?)?\b/i,
    /\bskill(?:s)?:\s*([A-Za-z#+.][\w#+.\-/]*)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseCityLocation(message) {
  const raw = String(message || '');
  if (/\bremote\b/i.test(raw)) return null;
  const m = raw.match(
    /\b(?:in|at|located in|based in)\s+([A-Za-z][A-Za-z\s.-]{1,40}?)(?:\s+(?:jobs?|openings?|positions?)|[?.!,]|$)/i,
  );
  // The lazy capture runs to end-of-sentence when no job noun follows ("jobs in ai do we
  // have" → "ai do we have"); cut the trailing question filler.
  const city = m?.[1]
    ?.replace(/\s+(?:do|does|did|are|is|were|was|we|you|have|has|there|right|now|currently|today)\b.*$/i, '')
    .trim();
  return city || null;
}

/** Anchored to a job-noun so "internally" / "internal review" don't fire origin filters. */
const JOB_ORIGIN_INTERNAL_RE = /\binternal\s+(?:jobs?|openings?|positions?|postings?|vacanc(?:y|ies))\b/i;
const JOB_ORIGIN_EXTERNAL_RE = /\bexternal\s+(?:jobs?|openings?|positions?|postings?|vacanc(?:y|ies)|listings?)\b/i;

export function parseJobFilters(message, ctx = null) {
  const t = String(message || '').toLowerCase();
  const filters = { ...(ctx?.filters || {}) };

  if (/\b(closed|filled|archived|draft)\b/.test(t)) {
    if (/\bclosed\b|\bfilled\b/.test(t)) filters.status = 'Closed';
    else if (/\barchived\b/.test(t)) filters.status = 'Archived';
    else if (/\bdraft\b/.test(t)) filters.status = 'Draft';
  } else if (/\b(right now|currently|active|open|live)\b/.test(t)) {
    // Only default to Active when the message expresses open/active intent — a plain
    // "how many jobs" / "list all jobs" must cover every status, and say so downstream.
    filters.status = 'Active';
  }

  if (/\bremote\b/.test(t)) filters.remote = true;
  if (/\bintern(?:ship)?\b/.test(t)) filters.jobType = 'Internship';
  else if (/\bpart[\s-]?time\b/.test(t)) filters.jobType = 'Part-time';
  else if (/\bcontract\b/.test(t)) filters.jobType = 'Contract';
  else if (/\bfull[\s-]?time\b/.test(t)) filters.jobType = 'Full-time';
  else if (/\btemporary\b/.test(t)) filters.jobType = 'Temporary';
  else if (/\bfreelance\b/.test(t)) filters.jobType = 'Freelance';

  const companyMatch = String(message || '').match(
    /\b(?:at|for|from|company)\s+([A-Za-z0-9][\w\s&.-]{1,60}?)(?:\s+(?:jobs?|openings?|positions?)|[?.!,]|$)/i
  );
  if (companyMatch) filters.company = companyMatch[1].trim();

  const deptMatch = String(message || '').match(
    /\b(?:department|dept)\s+(?:of\s+)?([A-Za-z0-9][\w\s&.-]{1,40}?)(?:\s+(?:jobs?|openings?)|[?.!,]|$)/i
  );
  if (deptMatch) filters.department = deptMatch[1].trim();

  if (JOB_ORIGIN_INTERNAL_RE.test(t)) filters.jobOrigin = 'internal';
  else if (JOB_ORIGIN_EXTERNAL_RE.test(t)) filters.jobOrigin = 'external';

  const skill = parseSkillFilter(message);
  if (skill) filters.skill = skill;

  const salaryMin = parseSalaryThreshold(message);
  if (salaryMin != null) filters.salaryMin = salaryMin;

  const exp = parseExperienceYears(message);
  if (exp?.experienceMin != null) filters.experienceMin = exp.experienceMin;
  if (exp?.experienceMax != null) filters.experienceMax = exp.experienceMax;

  const city = parseCityLocation(message);
  if (city) filters.city = city;

  return filters;
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
 * @param {{ userMessage: string, jobQueryContext?: object|null }} input
 * @returns {object|null}
 */
export function planJobRankQuery({ userMessage, jobQueryContext = null }) {
  const message = String(userMessage || '').trim();
  if (!message) return null;

  const ctx = jobQueryContext;

  const followUp = parseRankFollowUp(message, ctx?.metric === JOB_SALARY_METRIC ? ctx : null);
  if (followUp) {
    return {
      ...basePlanFromContext({ ...ctx, direction: followUp.direction }),
      ...followUp,
      intent: 'job_salary_ranking',
    };
  }

  if (!looksLikeJobRankingQuery(message)) return null;

  const direction = resolveRankDirection(message);
  const limit = resolveRankLimit(message, {
    singleItemRe: /\b(which|what)\b[\s\S]*\bjob\b/i,
  });
  const offset = resolveRankOffset(message);
  const operation = resolveRankOperation(message, limit, offset, direction);
  const filters = parseJobFilters(message, ctx);

  // Match the ATS Jobs page's own default: Active, unless the user named another status or
  // explicitly asked for every status ("all statuses", "any status", "including closed",
  // "every status", "ever posted").
  if (JOB_ALL_STATUSES_STRONG_RE.test(message)) {
    filters.status = 'all';
  } else if (!filters.status) {
    filters.status = 'Active';
  }

  return {
    entity: ENTITY_JOB,
    operation,
    metric: JOB_SALARY_METRIC,
    direction,
    limit,
    offset,
    filters,
    intent: operation === 'MAX' && limit === 1 && offset === 0 ? 'highest_salary_job' : 'job_salary_ranking',
  };
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

