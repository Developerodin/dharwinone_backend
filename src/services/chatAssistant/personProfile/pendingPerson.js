// src/services/chatAssistant/personProfile/pendingPerson.js
//
// All writes go through findOneAndUpdate/$set. lastEntities.lastContext is Mixed
// and mongoose does not dirty-track Mixed, so a nested mutation followed by
// .save() is a silent no-op; using $set sidesteps that class of bug entirely.

import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

export const PENDING_TTL_MS = 10 * 60 * 1000;

const PATH = 'lastEntities.pendingPersonDisambiguation';

/** Matches carry name + roles only. Disambiguation is not a read path. */
function slimMatch(m) {
  return { userId: m.userId, name: m.name, roles: m.roles ?? [] };
}

export async function writePending({ userId, adminId, query, matches,
                                     ConversationMemory = ConversationMemoryModel }) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    { $set: { [PATH]: { query, matches: matches.map(slimMatch), createdAt: new Date() } } },
    { upsert: true }
  );
}

export async function readPending({ userId, adminId, now = Date.now(),
                                    ConversationMemory = ConversationMemoryModel }) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const p = doc?.lastEntities?.pendingPersonDisambiguation;
  if (!p?.createdAt || !p.matches?.length) return null;
  if (now - new Date(p.createdAt).getTime() > PENDING_TTL_MS) return null;
  return p;
}

export async function clearPending({ userId, adminId,
                                     ConversationMemory = ConversationMemoryModel }) {
  await ConversationMemory.findOneAndUpdate({ userId, adminId }, { $unset: { [PATH]: 1 } });
}

/**
 * currentPerson. personUserId / personEmpDocId already exist on the model and are
 * already carried forward by mergeEntities — this writes into that same slot so
 * follow-ups ("what projects is he working on?") resolve without re-resolving.
 */
export async function writeCurrentPerson({ userId, adminId, target,
                                           ConversationMemory = ConversationMemoryModel }) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    { $set: {
        'lastEntities.personUserId':   target.userId,
        'lastEntities.personEmpDocId': target.empDocId ?? null,
        'lastEntities.person':         target.name,
      } },
    { upsert: true }
  );
}
