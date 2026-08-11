import ConversationMemory from '../../../models/conversationMemory.model.js';

const APPLICATION_QUERY_CONTEXT_PATH = 'lastEntities.applicationQueryContext';
const LAST_QUERY_DOMAIN_PATH = 'lastEntities.lastQueryDomain';

/**
 * @param {object|null} memoryDoc
 * @returns {object|null}
 */
export function readApplicationQueryContext(memoryDoc = null) {
  const ctx = memoryDoc?.lastEntities?.applicationQueryContext;
  const lastQueryDomain = memoryDoc?.lastEntities?.lastQueryDomain ?? ctx?.domain ?? null;
  if (!ctx?.applicantName && lastQueryDomain !== 'applications') return null;
  if (!ctx?.applicantName) {
    return {
      applicantName: null,
      userId: null,
      domain: 'applications',
      lastQueryDomain: 'applications',
      statusFilter: ctx?.statusFilter ?? null,
      lastTotal: ctx?.lastTotal ?? null,
      operation: ctx?.operation ?? null,
      updatedAt: ctx?.updatedAt ?? null,
    };
  }
  return {
    applicantName: ctx.applicantName,
    userId: ctx.userId ?? null,
    domain: ctx.domain ?? 'applications',
    lastQueryDomain: lastQueryDomain ?? ctx.domain ?? 'applications',
    statusFilter: ctx.statusFilter ?? null,
    lastTotal: ctx.lastTotal ?? null,
    operation: ctx.operation ?? null,
    updatedAt: ctx.updatedAt ?? null,
  };
}

/**
 * @param {{ userId:any, adminId:any, queryContext:object, ConversationMemory?:typeof ConversationMemory }} opts
 */
export async function saveApplicationQueryContext({
  userId,
  adminId,
  queryContext,
  ConversationMemory: MemoryModel = ConversationMemory,
}) {
  if (!userId || !adminId || !queryContext?.applicantName) return null;
  const domain = queryContext.domain ?? 'applications';
  await MemoryModel.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [APPLICATION_QUERY_CONTEXT_PATH]: { ...queryContext, domain, updatedAt: new Date() },
        [LAST_QUERY_DOMAIN_PATH]: domain,
      },
    },
    { upsert: true }
  );
  return queryContext;
}
