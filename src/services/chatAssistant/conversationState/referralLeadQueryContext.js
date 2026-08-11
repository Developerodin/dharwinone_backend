import ConversationMemory from '../../../models/conversationMemory.model.js';

const REFERRAL_LEAD_QUERY_CONTEXT_PATH = 'lastEntities.referralLeadQueryContext';

/**
 * @param {object|null} memoryDoc
 * @returns {object|null}
 */
export function readReferralLeadQueryContext(memoryDoc = null) {
  const ctx = memoryDoc?.lastEntities?.referralLeadQueryContext;
  if (!ctx?.candidateName && !ctx?.salesAgentName && !ctx?.referrerName) return null;
  return {
    candidateName: ctx.candidateName ?? null,
    candidateId: ctx.candidateId ?? null,
    salesAgentName: ctx.salesAgentName ?? null,
    salesAgentUserId: ctx.salesAgentUserId ?? null,
    referrerName: ctx.referrerName ?? null,
    referrerUserId: ctx.referrerUserId ?? null,
    lastIntent: ctx.lastIntent ?? null,
    lastTotal: ctx.lastTotal ?? null,
    updatedAt: ctx.updatedAt ?? null,
  };
}

/**
 * @param {{ userId:any, adminId:any, queryContext:object, ConversationMemory?:typeof ConversationMemory }} opts
 */
export async function saveReferralLeadQueryContext({
  userId,
  adminId,
  queryContext,
  ConversationMemory: MemoryModel = ConversationMemory,
}) {
  if (!userId || !adminId || !queryContext) return null;
  const hasAnchor =
    queryContext.candidateName ||
    queryContext.salesAgentName ||
    queryContext.referrerName;
  if (!hasAnchor) return null;

  await MemoryModel.findOneAndUpdate(
    { userId, adminId },
    { $set: { [REFERRAL_LEAD_QUERY_CONTEXT_PATH]: { ...queryContext, updatedAt: new Date() } } },
    { upsert: true }
  );
  return queryContext;
}
