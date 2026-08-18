import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

const PATH = 'lastEntities.currentEntitySubject';

/**
 * @param {{ userId:any, adminId:any, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function readEntitySubject({
  userId, adminId, ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const subject = doc?.lastEntities?.currentEntitySubject;
  if (!subject?.userId && !subject?.entityId && !subject?.name && !subject?.jobId) return null;
  // userId is a User ref. For job subjects entityId holds a Job _id (including
  // legacy docs written before the write-side guard), so the entityId fallback
  // must never apply to them — a Job id surfacing as userId sends person
  // resolvers off to load a "person" that is actually a job posting.
  const isJob = (subject.entityType || 'employee') === 'job';
  return {
    entityType: subject.entityType || 'employee',
    entityId: subject.entityId ? String(subject.entityId) : null,
    userId: subject.userId
      ? String(subject.userId)
      : (!isJob && subject.entityId ? String(subject.entityId) : null),
    employeeId: subject.employeeId || null,
    empDocId: subject.empDocId ? String(subject.empDocId) : null,
    jobId: subject.jobId ? String(subject.jobId) : null,
    name: subject.name || null,
    updatedAt: subject.updatedAt || null,
  };
}

/**
 * @param {{ userId:any, adminId:any, subject:object, ConversationMemory?:typeof ConversationMemoryModel }} opts
 */
export async function writeEntitySubject({
  userId, adminId, subject, ConversationMemory = ConversationMemoryModel,
}) {
  // Job subjects must never occupy the User-ref userId slot — subjectFromJob
  // sets entityId to the Job _id, and the entityId fallback below would hand
  // that Job id to every person resolver on the next follow-up turn.
  const isJob = (subject.entityType || 'employee') === 'job';
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    {
      $set: {
        [PATH]: {
          entityType: subject.entityType || 'employee',
          entityId: subject.entityId ?? subject.userId ?? subject.jobId ?? null,
          userId: subject.userId ?? (isJob ? null : subject.entityId ?? null),
          employeeId: subject.employeeId ?? null,
          empDocId: subject.empDocId ?? null,
          jobId: subject.jobId ?? null,
          name: subject.name ?? null,
          updatedAt: new Date(),
        },
      },
    },
    { upsert: true }
  );
}

/**
 * Build a subject snapshot from a resolved person profile.
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 */
export function subjectFromProfile(profile) {
  if (profile?.kind !== 'unique') return null;
  const employee = profile.profiles?.employee;
  return {
    entityType: 'employee',
    entityId: profile.identity.userId,
    userId: profile.identity.userId,
    name: profile.identity.name,
    employeeId: employee?.fields?.employeeId ?? null,
    empDocId: employee?.docId ?? null,
  };
}

/**
 * Build a subject snapshot from a resolved job profile.
 * @param {{ jobId?: string, title?: string, _id?: any }} job
 */
export function subjectFromJob(job) {
  const jobId = job?.jobId ?? job?._id;
  if (!jobId) return null;
  return {
    entityType: 'job',
    entityId: String(jobId),
    jobId: String(jobId),
    name: job.title ?? null,
  };
}
