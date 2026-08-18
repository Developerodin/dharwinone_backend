import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

const PATH = 'lastEntities.personConversationState';

/**
 * @param {{ userId:any, adminId:any, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function readPersonConversationState({
  userId, adminId, ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const state = doc?.lastEntities?.personConversationState;
  if (!state?.entityId) return null;
  return {
    entityId: String(state.entityId),
    entityType: state.entityType || 'user',
    name: state.name || null,
    communicatedFields: Array.isArray(state.communicatedFields) ? [...state.communicatedFields] : [],
    updatedAt: state.updatedAt || null,
  };
}

/**
 * @param {{ userId:any, adminId:any, state:object, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function writePersonConversationState({
  userId, adminId, state, ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [PATH]: {
          entityId: state.entityId,
          entityType: state.entityType || 'user',
          name: state.name || null,
          communicatedFields: state.communicatedFields || [],
          updatedAt: new Date(),
        },
      },
    },
    { upsert: true }
  );
}

/**
 * Collect field keys the viewer can see across all role profiles.
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 */
export function collectVisibleFieldKeys(profile) {
  if (profile?.kind !== 'unique') return [];
  const keys = new Set(['name', 'roles']);
  for (const p of Object.values(profile.profiles || {})) {
    for (const k of p.visibleFields || []) keys.add(k);
  }
  return [...keys];
}

/**
 * @param {string[]} communicated
 * @param {string[]} usedNow
 */
export function mergeCommunicatedFields(communicated, usedNow) {
  return [...new Set([...(communicated || []), ...(usedNow || [])])];
}
