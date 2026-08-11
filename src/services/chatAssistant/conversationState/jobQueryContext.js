import ConversationMemory from '../../../models/conversationMemory.model.js';

const JOB_QUERY_CONTEXT_PATH = 'lastEntities.jobQueryContext';

/**
 * @param {object|null} memoryDoc
 * @returns {object|null}
 */
export function readJobQueryContext(memoryDoc = null) {
  const ctx = memoryDoc?.lastEntities?.jobQueryContext;
  if (!ctx) return null;
  const hasFilters = ctx.filters && Object.keys(ctx.filters).length > 0;
  if (!ctx.metric && !hasFilters && !ctx.intent) return null;
  return {
    entity: ctx.entity ?? 'job',
    operation: ctx.operation ?? null,
    metric: ctx.metric ?? null,
    direction: ctx.direction ?? 'desc',
    filters: { ...(ctx.filters || {}) },
    limit: ctx.limit ?? null,
    offset: ctx.offset ?? 0,
    intent: ctx.intent ?? null,
    queryId: ctx.queryId ?? null,
    lastTotal: ctx.lastTotal ?? null,
    updatedAt: ctx.updatedAt ?? null,
  };
}

/**
 * @param {object} plan
 * @param {object} result
 * @returns {object}
 */
export function buildJobQueryContextFromResult(plan, result) {
  return {
    entity: plan.entity ?? 'job',
    operation: plan.operation ?? null,
    metric: plan.metric ?? null,
    direction: plan.direction ?? 'desc',
    filters: { ...(plan.filters || {}) },
    limit: plan.limit ?? null,
    offset: plan.offset ?? 0,
    intent: plan.intent ?? null,
    lastTotal: result?.result?.total ?? result?.total ?? null,
    queryId: result?.query?.queryId ?? result?.queryId ?? null,
    updatedAt: new Date(),
  };
}

/**
 * @param {{ userId:any, adminId:any, queryContext:object, ConversationMemory?:typeof ConversationMemory }} opts
 */
export async function saveJobQueryContext({
  userId,
  adminId,
  queryContext,
  ConversationMemory: MemoryModel = ConversationMemory,
}) {
  if (!userId || !adminId || !queryContext) return null;
  await MemoryModel.findOneAndUpdate(
    { userId, adminId },
    { $set: { [JOB_QUERY_CONTEXT_PATH]: queryContext } },
    { upsert: true }
  );
  return queryContext;
}
