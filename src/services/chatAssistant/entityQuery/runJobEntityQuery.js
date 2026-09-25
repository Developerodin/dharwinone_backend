import Job from '../../../models/job.model.js';
import { executeRankQuery } from '../queryPlanner/executeRank.js';
import {
  decorateRankedJobRows,
  looksLikeJobRankingQuery,
  planJobRankQuery,
  resolveJobVisibilityFilter,
  scopeJobModel,
  verifyCompanyCandidate,
} from '../queryPlanner/entities/jobRank.js';
import { renderJobRanking } from '../renderers/jobRanking.js';
import {
  planJobFilterQuery,
  parseJobFollowUp,
  looksLikeJobFilterQuery,
} from '../queryPlanner/entities/jobFilter.js';
import {
  executeAtomicJobQuery,
  assertJobResultIntegrity,
} from '../jobResult.js';
import { renderJobResult } from '../renderers/jobs.js';
import {
  buildJobQueryContextFromResult,
  saveJobQueryContext,
} from '../conversationState/jobQueryContext.js';

export { looksLikeJobRankingQuery, looksLikeJobFilterQuery, parseJobFollowUp };

/**
 * Deterministic job filter orchestrator — count/list with origin filters.
 */
export async function runJobFilterQuery({
  userMessage,
  user,
  jobQueryContext = null,
  requestId = null,
  deps = {},
}) {
  const plan =
    deps.planJobFilterQuery?.({ userMessage, jobQueryContext }) ??
    planJobFilterQuery({ userMessage, jobQueryContext });

  if (!plan) return null;

  // parseJobFilters' company regex over-captures role nouns / locations ("jobs for React
  // devs", "at Bangalore") — verify against real data before querying on it.
  if (plan.filters?.company) {
    const verified = await (deps.verifyCompanyCandidate?.(plan.filters.company, { Job: deps.Job ?? Job }) ??
      verifyCompanyCandidate(plan.filters.company, { Job: deps.Job ?? Job }));
    if (!verified) {
      plan.filters = { ...plan.filters };
      delete plan.filters.company;
    }
  }

  const started = deps.now?.() ?? Date.now();
  const listIntent = plan.intent === 'list';

  // Sage's job visibility must match the ATS Jobs page — non-privileged users only see
  // their own internal jobs + external mirrors. executeAtomicJobQuery (jobResult.js)
  // builds/owns its Mongo filter internally, so it's scoped via a wrapped JobModel
  // rather than by threading the filter through plan.filters.
  const visibilityFilter =
    (await deps.resolveJobVisibilityFilter?.(user)) ?? (await resolveJobVisibilityFilter(user));
  const ScopedJob = scopeJobModel(deps.Job ?? Job, visibilityFilter);

  const envelope =
    (await deps.executeAtomicJobQuery?.({
      filters: plan.filters,
      limit: plan.limit ?? 50,
      listIntent,
      JobModel: ScopedJob,
    })) ??
    (await executeAtomicJobQuery({
      filters: plan.filters,
      limit: plan.limit ?? 50,
      listIntent,
      JobModel: ScopedJob,
    }));

  assertJobResultIntegrity(envelope);

  const rendered =
    deps.renderJobResult?.(envelope, { listIntent }) ??
    renderJobResult(envelope, { listIntent });

  if (user?.id) {
    await (deps.saveJobQueryContext?.({
      userId: user.id,
      adminId: user.adminId ?? user.id,
      queryContext: buildJobQueryContextFromResult(plan, envelope),
    }) ??
      saveJobQueryContext({
        userId: user.id,
        adminId: user.adminId ?? user.id,
        queryContext: buildJobQueryContextFromResult(plan, envelope),
      }));
  }

  return {
    reply: rendered.markdown,
    blocks: rendered.block ? [rendered.block] : [],
    deterministic: true,
    plan,
    jobResult: envelope,
    records: envelope.result.jobs,
    total: envelope.result.total ?? null,
    tookMs: (deps.now?.() ?? Date.now()) - started,
    requestId,
  };
}

/**
 * Deterministic job salary ranking orchestrator.
 */
async function runJobRankQuery({
  userMessage,
  user,
  jobQueryContext = null,
  requestId = null,
  deps = {},
}) {
  const plan =
    deps.planRankQuery?.(userMessage, { job: jobQueryContext }) ??
    planJobRankQuery({ userMessage, jobQueryContext });

  if (!plan) return null;

  // parseJobFilters' company regex over-captures role nouns / locations ("jobs for React
  // devs", "at Bangalore") — verify against real data before querying on it.
  if (plan.filters?.company) {
    const verified = await (deps.verifyCompanyCandidate?.(plan.filters.company, { Job: deps.Job ?? Job }) ??
      verifyCompanyCandidate(plan.filters.company, { Job: deps.Job ?? Job }));
    if (!verified) {
      plan.filters = { ...plan.filters };
      delete plan.filters.company;
    }
  }

  const started = deps.now?.() ?? Date.now();

  // Sage's job visibility must match the ATS Jobs page — see runJobFilterQuery above.
  const visibilityFilter =
    (await deps.resolveJobVisibilityFilter?.(user)) ?? (await resolveJobVisibilityFilter(user));

  const rawResult =
    (await deps.executeRankQuery?.(plan, { Job: deps.Job ?? Job, visibilityFilter })) ??
    (await executeRankQuery(plan, { Job: deps.Job ?? Job, visibilityFilter }));

  const jobs = decorateRankedJobRows(rawResult.items, (plan.offset ?? 0) + 1);
  const result = { ...rawResult, jobs, total: rawResult.total };

  const rendered =
    deps.renderJobRanking?.(plan, result) ?? renderJobRanking(plan, result);

  if (user?.id) {
    await (deps.saveJobQueryContext?.({
      userId: user.id,
      adminId: user.adminId ?? user.id,
      queryContext: buildJobQueryContextFromResult(plan, result),
    }) ??
      saveJobQueryContext({
        userId: user.id,
        adminId: user.adminId ?? user.id,
        queryContext: buildJobQueryContextFromResult(plan, result),
      }));
  }

  return {
    reply: rendered.markdown,
    blocks: rendered.block ? [rendered.block] : [],
    deterministic: true,
    plan,
    records: jobs,
    total: result.total ?? null,
    tookMs: (deps.now?.() ?? Date.now()) - started,
    requestId,
  };
}

/**
 * Route job queries to filter (count/list) or salary ranking handlers.
 */
export async function runJobEntityQuery(opts) {
  const { userMessage, jobQueryContext = null } = opts;
  if (
    planJobFilterQuery({ userMessage, jobQueryContext }) ||
    parseJobFollowUp(userMessage, jobQueryContext) ||
    looksLikeJobFilterQuery(userMessage)
  ) {
    return runJobFilterQuery(opts);
  }
  return runJobRankQuery(opts);
}

/**
 * @param {string} userMessage
 * @param {object|null} lastContext
 * @returns {boolean}
 */
export function shouldHandleJobEntityQuery(userMessage, lastContext = null) {
  const ctx = lastContext?.jobQueryContext ?? null;
  if (parseJobFollowUp(userMessage, ctx)) return true;
  if (looksLikeJobFilterQuery(userMessage)) return true;
  if (looksLikeJobRankingQuery(userMessage)) return true;
  if (/^\s*top\s+\d+\s*\.?\s*$/i.test(String(userMessage || '')) && ctx?.metric === 'salary') {
    return true;
  }
  if (/\b(second|third|fourth|fifth)\s+(highest|lowest|top|paying)\b/i.test(String(userMessage || '')) && ctx?.metric === 'salary') {
    return true;
  }
  return false;
}
