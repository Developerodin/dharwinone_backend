// uat.dharwin.backend/src/services/chatAssistant/entityCleanup.js
//
// Cascade cleanup helpers fired when an entity is removed or mutated.
// Best-effort — every helper logs and swallows errors so a hooked
// caller (Mongoose post-save, deleteUserById) is never blocked by a
// broken Pinecone or memory write.

import logger from '../../config/logger.js';
import ConversationMemory from '../../models/conversationMemory.model.js';
import { pineconeDelete } from '../../utils/pinecone.util.js';
import { bustRoleRegistry } from './roleRegistry.js';

/** Pinecone IDs follow embeddingSync.scheduler.js conventions. */
async function deletePineconeForUser(userId) {
  if (!userId) return;
  const id = String(userId);
  await Promise.all([
    pineconeDelete('employees', [`employee_${id}`]).catch((err) =>
      logger.warn(`[entityCleanup] pinecone employees delete failed for ${id}: ${err.message}`)
    ),
    pineconeDelete('students', [`student_${id}`]).catch((err) =>
      logger.warn(`[entityCleanup] pinecone students delete failed for ${id}: ${err.message}`)
    ),
  ]);
}

/**
 * Drop chatbot memory references to a user that no longer exists — only the
 * person pointer on pre-removal legacy rows (see ConversationMemory.lastEntities).
 */
async function clearMemoryReferencesForUser(userId) {
  if (!userId) return;
  try {
    const result = await ConversationMemory.updateMany(
      { 'lastEntities.personUserId': userId },
      {
        $set: {
          'lastEntities.personUserId': null,
          'lastEntities.personEmpDocId': null,
          'lastEntities.person': null,
          'lastEntities.email': null,
          'lastEntities.employeeId': null,
        },
      }
    );
    if (result.modifiedCount > 0) {
      logger.info(`[entityCleanup] cleared person from ${result.modifiedCount} memory rows (userId=${userId})`);
    }
  } catch (err) {
    logger.warn(`[entityCleanup] memory clear failed for ${userId}: ${err.message}`);
  }
}

async function clearMemoryReferencesForRole(roleId) {
  if (!roleId) return;
  try {
    const result = await ConversationMemory.updateMany(
      { 'lastEntities.roleId': roleId },
      {
        $set: {
          'lastEntities.roleId': null,
          'lastEntities.roleSlug': null,
          'lastEntities.role': null,
        },
      }
    );
    if (result.modifiedCount > 0) {
      logger.info(`[entityCleanup] cleared role from ${result.modifiedCount} memory rows (roleId=${roleId})`);
    }
  } catch (err) {
    logger.warn(`[entityCleanup] memory role clear failed for ${roleId}: ${err.message}`);
  }
}

/**
 * Fire all user-cleanup steps. Safe from a hard-delete path (call before
 * User.deleteOne) or a soft-delete path (call after status='deleted').
 *
 * @param {{ userId: any }} params
 */
export async function cascadeUserRemoval({ userId }) {
  await Promise.all([
    deletePineconeForUser(userId),
    clearMemoryReferencesForUser(userId),
  ]);
}

/**
 * Fire all role-cleanup steps: bust the role registry and drop memory references.
 *
 * @param {{ roleId: any }} params
 */
export async function cascadeRoleMutation({ roleId }) {
  bustRoleRegistry();
  await clearMemoryReferencesForRole(roleId);
}
