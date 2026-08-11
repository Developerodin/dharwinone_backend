import ConversationMemory from '../../models/conversationMemory.model.js';

/**
 * Persist task query filters for follow-ups ("which ones?", "list them").
 */
export async function saveTaskQueryContext({
  userId,
  adminId,
  taskResult,
  userMessage = '',
}) {
  if (!userId || !adminId || !taskResult) return null;

  const filters = taskResult?.query?.filters ?? taskResult?.filters ?? {};
  const total = taskResult?.result?.total ?? taskResult?.total ?? null;
  const tasks = taskResult?.result?.tasks ?? taskResult?.rows ?? [];
  const queryId = taskResult?.query?.queryId ?? taskResult?.queryId ?? null;

  const lastContext = {
    entity: 'task',
    filters: { ...filters },
    total,
    queryId,
    lastTaskIds: tasks.map((t) => t.taskId).filter(Boolean),
    lastUserMessage: userMessage || null,
    updatedAt: new Date(),
  };

  const $set = {
    'lastEntities.currentTaskQueryContext': lastContext,
    'lastEntities.lastTopic': 'tasks',
    'lastEntities.lastTaskStage': filters.status || null,
    'lastEntities.lastTaskCount': total,
    'lastEntities.updatedAt': new Date(),
  };

  if (filters.status) {
    $set['lastEntities.lastTaskStage'] = filters.status;
  }

  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set,
      $inc: { turnCount: 1 },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    { upsert: true },
  );

  return lastContext;
}

/**
 * @param {object|null} memoryDoc
 */
export function readTaskQueryContext(memoryDoc = null) {
  const ctx = memoryDoc?.lastEntities?.currentTaskQueryContext;
  if (!ctx?.filters) return null;
  return {
    filters: { ...ctx.filters },
    queryId: ctx.queryId ?? null,
    total: ctx.total ?? null,
    lastTaskIds: ctx.lastTaskIds || [],
  };
}
