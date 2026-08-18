// Pending user-vs-role (or mixed) and job-vs-employee title disambiguation.

import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

export const PENDING_TTL_MS = 10 * 60 * 1000;
const PATH = 'lastEntities.pendingEntityDisambiguation';
const TITLE_PATH = 'lastEntities.pendingTitleDisambiguation';

function slimMatch(m) {
  if (m.kind === 'role') {
    return { kind: 'role', roleId: m.roleId, name: m.name };
  }
  return { kind: 'user', userId: m.userId, name: m.name, roles: m.roles ?? [] };
}

export async function writePendingEntity({
  userId,
  adminId,
  query,
  matches,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    { $set: { [PATH]: { query, matches: matches.map(slimMatch), createdAt: new Date() } } },
    { upsert: true }
  );
}

export async function readPendingEntity({
  userId,
  adminId,
  now = Date.now(),
  ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const p = doc?.lastEntities?.pendingEntityDisambiguation;
  if (!p?.createdAt || !p.matches?.length) return null;
  if (now - new Date(p.createdAt).getTime() > PENDING_TTL_MS) return null;
  return p;
}

export async function clearPendingEntity({
  userId,
  adminId,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate({ userId, adminId }, { $unset: { [PATH]: 1 } });
}

function slimTitleMatch(m) {
  if (m.kind === 'job') {
    return { kind: 'job', jobId: m.jobId, title: m.title, status: m.status ?? null };
  }
  return {
    kind: 'employee',
    empDocId: m.empDocId,
    owner: m.owner,
    name: m.name,
    designation: m.designation ?? null,
  };
}

export async function writePendingTitle({
  userId,
  adminId,
  query,
  jobMatches,
  employeeMatches,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [TITLE_PATH]: {
          query,
          jobMatches: jobMatches.map(slimTitleMatch),
          employeeMatches: employeeMatches.map(slimTitleMatch),
          createdAt: new Date(),
        },
      },
    },
    { upsert: true }
  );
}

export async function readPendingTitle({
  userId,
  adminId,
  now = Date.now(),
  ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const p = doc?.lastEntities?.pendingTitleDisambiguation;
  if (!p?.createdAt) return null;
  if (now - new Date(p.createdAt).getTime() > PENDING_TTL_MS) return null;
  if (!p.jobMatches?.length && !p.employeeMatches?.length) return null;
  return p;
}

export async function clearPendingTitle({
  userId,
  adminId,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate({ userId, adminId }, { $unset: { [TITLE_PATH]: 1 } });
}
