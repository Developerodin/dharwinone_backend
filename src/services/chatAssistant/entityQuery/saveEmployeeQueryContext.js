import ConversationMemory from '../../../models/conversationMemory.model.js';
import { buildQueryContextFromPlan } from '../conversationState/queryContextState.js';
import { buildGroupId } from '../queryPlanner/filterGroups.js';

/**
 * Persist employee entityQuery lastContext without OpenAI compression.
 * Awaited on every deterministic entityQuery response — do not use saveMemoryAsync.
 */
export async function saveEmployeeQueryContext({
  userId,
  adminId,
  structuredQuery,
  toolResult,
  queryPlan = null,
  compoundResult = null,
}) {
  if (!userId || !adminId || !structuredQuery) {
    return null;
  }

  const records = Array.isArray(toolResult?.records) ? toolResult.records : [];
  const lastResultList = records.slice(0, 10).map((r) => ({
    name: r.fullName || r.name || null,
    employeeId: r.employeeId || null,
    _id: r._id || null,
    email: r.email || null,
  }));

  const lastContext = {
    entity: structuredQuery.entity,
    operations: structuredQuery.operations,
    filters: structuredQuery.filters ? { ...structuredQuery.filters } : {},
    pagination: structuredQuery.pagination ? { ...structuredQuery.pagination } : undefined,
    scope: structuredQuery.scope ? { ...structuredQuery.scope } : undefined,
    total: toolResult?.total ?? null,
    lastResultList,
    updatedAt: new Date(),
  };

  if (queryPlan?.filterGroups?.length) {
    lastContext.filterGroups = queryPlan.filterGroups.map((g) => ({
      id: g.id,
      filters: { ...g.filters },
    }));
    lastContext.isCompound = queryPlan.filterGroups.length > 1;
    lastContext.currentQueryContext = buildQueryContextFromPlan(queryPlan, compoundResult);
  } else if (structuredQuery.filters && Object.keys(structuredQuery.filters).length) {
    lastContext.currentQueryContext = buildQueryContextFromPlan(
      {
        intent: structuredQuery.operations?.includes('list') ? 'list' : 'count',
        filterGroups: [
          {
            id: buildGroupId(structuredQuery.filters),
            filters: { ...structuredQuery.filters },
          },
        ],
        pagination: structuredQuery.pagination,
        operator: 'OR',
      },
      compoundResult
    );
  }

  const primaryOp = structuredQuery.operations?.includes('count') ? 'count' : 'list';

  const $set = {
    'lastEntities.lastContext': lastContext,
    'lastEntities.lastEntityType': 'employees',
    'lastEntities.lastIntent': primaryOp,
    'lastEntities.lastTopic': 'employees',
    'lastEntities.lastResultList': lastResultList,
    'lastEntities.updatedAt': new Date(),
  };

  if (lastContext.currentQueryContext) {
    $set['lastEntities.currentQueryContext'] = lastContext.currentQueryContext;
  }

  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set,
      $inc: { turnCount: 1 },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    { upsert: true }
  );

  return lastContext;
}
