import ConversationMemoryModel from '../../../models/conversationMemory.model.js';
import { agentEmployeeFilterBase } from '../agentEmployeeRelation.js';

const PATH = 'lastEntities.currentAgentSubject';

/**
 * @param {{ userId:any, adminId:any, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function readAgentSubject({
  userId, adminId, ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const subject = doc?.lastEntities?.currentAgentSubject;
  if (!subject?.agentId && !subject?.name) return null;
  const agentId = subject.agentId ? String(subject.agentId) : null;
  return {
    agentId,
    name: subject.name || null,
    statusScope: subject.statusScope || null,
    employeeFilterBase:
      subject.employeeFilterBase ||
      (agentId ? agentEmployeeFilterBase(agentId) : {}),
    updatedAt: subject.updatedAt || null,
  };
}

/**
 * @param {{ userId:any, adminId:any, subject:object, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function writeAgentSubject({
  userId, adminId, subject, ConversationMemory = ConversationMemoryModel,
}) {
  const agentId = subject.agentId ? String(subject.agentId) : null;
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [PATH]: {
          agentId,
          name: subject.name ?? null,
          statusScope: subject.statusScope ?? null,
          employeeFilterBase:
            subject.employeeFilterBase ||
            (agentId ? agentEmployeeFilterBase(agentId) : {}),
          updatedAt: new Date(),
        },
      },
    },
    { upsert: true }
  );
}

/**
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 */
export function subjectFromAgentProfile(profile) {
  if (profile?.kind !== 'unique') return null;
  const roles = profile.identity?.roles || [];
  if (!roles.some((r) => /^agent$/i.test(String(r)))) return null;
  const agentId = String(profile.identity.userId);
  return {
    agentId,
    name: profile.identity.name,
    employeeFilterBase: agentEmployeeFilterBase(agentId),
  };
}
