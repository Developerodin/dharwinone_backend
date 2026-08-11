import { executeJobRank } from './entities/jobRank.js';

const RANK_EXECUTORS = Object.freeze({
  job: executeJobRank,
});

/**
 * Execute a structured rank plan via the entity registry.
 *
 * @param {object} plan
 * @param {object} [ctx]
 * @returns {Promise<{ success: boolean, total: number, items: object[], filters: object, queryId: string|null, plan: object }>}
 */
export async function executeRankQuery(plan, ctx = {}) {
  const exec = RANK_EXECUTORS[plan?.entity];
  if (!exec) {
    return {
      success: false,
      total: 0,
      items: [],
      filters: plan?.filters ?? {},
      queryId: plan?.intent ?? null,
      plan,
      error: 'UNKNOWN_ENTITY',
    };
  }

  const raw = await exec(plan, ctx);
  const items = raw.jobs ?? raw.items ?? [];

  return {
    success: raw.success !== false,
    total: raw.total ?? 0,
    items,
    filters: raw.filters ?? plan.filters ?? {},
    queryId: plan.intent ?? null,
    plan,
    ...raw,
  };
}
