import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

const PATH = 'lastEntities.positionConversationState';

/**
 * @param {{ userId:any, adminId:any, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function readPositionConversationState({
  userId,
  adminId,
  ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const state = doc?.lastEntities?.positionConversationState;
  if (!state?.designation) return null;
  return {
    entity: state.entity || 'employee',
    designation: state.designation,
    source: state.source || null,
    updatedAt: state.updatedAt || null,
  };
}

/**
 * @param {{ userId:any, adminId:any, state:object, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function writePositionConversationState({
  userId,
  adminId,
  state,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [PATH]: {
          entity: state.entity || 'employee',
          designation: state.designation,
          source: state.source || 'title_ambiguity',
          updatedAt: new Date(),
        },
      },
    },
    { upsert: true }
  );
}

/**
 * @param {{ userId:any, adminId:any, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function clearPositionConversationState({
  userId,
  adminId,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate({ userId, adminId }, { $unset: { [PATH]: 1 } });
}

/**
 * Build lastContext shell for designation-scoped employee queries.
 * @param {string} designation
 * @param {{ operation?: 'count'|'list' }} [opts]
 */
export function buildDesignationEmployeeLastContext(designation, { operation = 'list' } = {}) {
  return {
    entity: 'employees',
    operations: [operation],
    filters: { designation, employmentStatus: 'all' },
    scope: { module: 'employees_with_position' },
  };
}
