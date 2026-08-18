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

const JOB_SUBJECT_RE =
  /\b(jobs?|openings?|vacanc(?:y|ies)|positions?|postings?)\b/i;

const SALARY_WORD_RE = /\b(salary|salaries|pay|compensation|package|paid)\b/i;

const SALARY_SUPERLATIVE_RE =
  /\b(highest[\s-]?pay(?:ing)?|top[\s-]?pay(?:ing)?|best[\s-]?pay(?:ing)?|lowest[\s-]?pay(?:ing)?|pays?\s+the\s+most|pay(?:s|ing)\s+the\s+(most|least|highest|lowest))\b/i;

const LIST_JOBS_RE =
  /\b(list( all)? jobs?|show( me)? (all )?jobs?|how many jobs?|total jobs?)\b/i;

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
  return m?.[1]?.trim() || null;
}

export function parseJobFilters(message, ctx = null) {
  const t = String(message || '').toLowerCase();
  const filters = { ...(ctx?.filters || {}) };

  if (/\b(closed|filled|archived|draft)\b/.test(t)) {
    if (/\bclosed\b|\bfilled\b/.test(t)) filters.status = 'Closed';
    else if (/\barchived\b/.test(t)) filters.status = 'Archived';
    else if (/\bdraft\b/.test(t)) filters.status = 'Draft';
  } else if (/\b(right now|currently|active|open|live)\b/.test(t) || !filters.status) {
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

  if (/\binternal\b/.test(t)) filters.jobOrigin = 'internal';
  else if (/\bexternal\b/.test(t)) filters.jobOrigin = 'external';

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
 * @param {object} plan
 * @returns {object}
 */
export function buildJobRankingMongoFilter(plan) {
  const filter = {};
  const f = plan.filters || {};

  if (f.status) filter.status = f.status;
  if (f.jobType) filter.jobType = f.jobType;
  if (f.jobOrigin === 'internal') filter.jobOrigin = { $ne: 'external' };
  else if (f.jobOrigin === 'external') filter.jobOrigin = 'external';
  if (f.company) {
    filter['organisation.name'] = { $regex: escapeRegex(f.company), $options: 'i' };
  }
  if (f.remote) {
    filter.location = { $regex: /remote/i };
  } else if (f.city) {
    filter.location = { $regex: escapeRegex(f.city), $options: 'i' };
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
  if (f.salaryMin != null && Number.isFinite(Number(f.salaryMin))) {
    appendFilterClause(filter, {
      $or: [
        { 'salaryRange.max': { $gte: Number(f.salaryMin) } },
        { 'salaryRange.min': { $gte: Number(f.salaryMin) } },
      ],
    });
  }
  if (f.experienceMin != null && Number.isFinite(Number(f.experienceMin))) {
    appendFilterClause(filter, {
      $or: [
        { minExperience: { $gte: Number(f.experienceMin) } },
        { maxExperience: { $gte: Number(f.experienceMin) } },
        {
          minExperience: { $exists: false },
          maxExperience: { $exists: false },
          experienceLevel: { $in: ['Mid Level', 'Senior Level', 'Executive'] },
        },
      ],
    });
  }
  if (f.experienceMax != null && Number.isFinite(Number(f.experienceMax))) {
    appendFilterClause(filter, {
      $or: [
        { maxExperience: { $lte: Number(f.experienceMax) } },
        { minExperience: { $lte: Number(f.experienceMax) } },
      ],
    });
  }
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
  if (f.search || f.title) {
    const term = escapeRegex(f.search || f.title);
    filter.title = { $regex: term, $options: 'i' };
  }

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
 * @param {{ Job?: import('mongoose').Model }} deps
 * @returns {Promise<{ success: boolean, jobs: object[], total: number, plan: object, filters: object }>}
 */
export async function executeJobRank(plan, deps = {}) {
  const Job = deps.Job;
  if (!Job) {
    return { success: false, jobs: [], total: 0, plan, error: 'NO_JOB_MODEL' };
  }

  const baseFilter = buildJobRankingMongoFilter(plan);
  const filter = buildSalarySpecifiedFilter(baseFilter);
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

