import ConversationMemory from '../../../models/conversationMemory.model.js';

const QUERY_CONTEXT_PATH = 'lastEntities.currentQueryContext';

/**
 * @param {object|null} memoryDoc
 * @returns {object|null}
 */
export function readQueryContext(memoryDoc = null) {
  const ctx = memoryDoc?.lastEntities?.currentQueryContext;
  if (!ctx?.filterGroups?.length) return null;
  return {
    entity: ctx.entity || 'employees',
    filterGroups: ctx.filterGroups.map((g) => ({
      id: g.id,
      filters: { ...g.filters },
    })),
    lastPresentedGroupId: ctx.lastPresentedGroupId ?? null,
    page: ctx.page ?? 1,
    intent: ctx.intent ?? null,
    operator: ctx.operator ?? 'OR',
    updatedAt: ctx.updatedAt ?? null,
  };
}

/**
 * @param {object} plan
 * @param {object} [compoundResult]
 * @returns {object}
 */
export function buildQueryContextFromPlan(plan, compoundResult = null) {
  const groups =
    compoundResult?.groups?.map((g) => ({
      id: g.id,
      filters: { ...g.filters },
      count: g.count ?? null,
    })) ??
    plan.filterGroups.map((g) => ({
      id: g.id,
      filters: { ...g.filters },
      count: null,
    }));

  return {
    entity: 'employees',
    filterGroups: groups,
    lastPresentedGroupId: plan.activeGroupId ?? (groups.length === 1 ? groups[0].id : null),
    page: plan.pagination?.page ?? 1,
    intent: plan.intent ?? 'count',
    operator: plan.operator ?? 'OR',
    updatedAt: new Date(),
  };
}

/**
 * @param {{ userId:any, adminId:any, queryContext:object, ConversationMemory?:typeof ConversationMemory }} opts
 */
export async function writeQueryContext({
  userId,
  adminId,
  queryContext,
  ConversationMemory: MemoryModel = ConversationMemory,
}) {
  if (!userId || !adminId || !queryContext) return null;
  await MemoryModel.findOneAndUpdate(
    { userId, adminId },
    { $set: { [QUERY_CONTEXT_PATH]: queryContext } },
    { upsert: true }
  );
  return queryContext;
}
