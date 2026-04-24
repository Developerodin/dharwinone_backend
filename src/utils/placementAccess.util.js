import Meeting from '../models/meeting.model.js';
import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
/**
 * @param {string} [jobPositionFromMeeting]
 * @param {import('mongoose').Types.ObjectId|string} placementJobId
 * @returns {Promise<boolean>}
 */
const jobMatchesPlacementJob = async (jobPositionFromMeeting, placementJobId) => {
  if (!placementJobId) return false;
  const p = String(placementJobId);
  const jp = (jobPositionFromMeeting || '').trim();
  if (/^[0-9a-fA-F]{24}$/.test(jp) && jp === p) return true;
  if (jp) {
    const jobDoc = await Job.findById(placementJobId).select('title').lean();
    if (jobDoc?.title && jobDoc.title.trim().toLowerCase() === jp.toLowerCase()) return true;
  }
  return false;
};

/**
 * Agent is "assigned" to this hire if their email is a host on an interview for same candidate user + job.
 * @param {import('mongoose').Document|null} employeeDoc - Employee with .owner
 * @param {import('mongoose').Types.ObjectId} placementJobId
 * @param {{ email?: string, id?: string, _id?: string }} viewerUser
 * @returns {Promise<boolean>}
 */
export const isAgentViewerAssignedToCandidate = async (employeeDoc, placementJobId, viewerUser) => {
  if (!employeeDoc?.owner || !viewerUser?.email) return false;
  const ownerId = String(employeeDoc.owner?._id || employeeDoc.owner);
  const ve = (viewerUser.email || '').trim().toLowerCase();
  if (!ve) return false;

  const meetings = await Meeting.find({
    'candidate.id': ownerId,
    status: { $ne: 'cancelled' },
  })
    .select('hosts jobPosition')
    .lean()
    .limit(200);

  for (const m of meetings) {
    const hostMatch = (m.hosts || []).some((h) => (h.email || '').trim().toLowerCase() === ve);
    if (!hostMatch) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await jobMatchesPlacementJob(m.jobPosition, placementJobId);
    if (ok) return true;
  }
  return false;
};

/**
 * After agent assignment is verified, admin and agent readers get stripped payloads; recruiters get full.
 * @param {object} currentUser
 * @returns {Promise<boolean>}
 */
export const shouldReturnStrippedPlacement = async (currentUser) => {
  const { userIsAdmin, userIsAgent } = await import('./roleHelpers.js');
  return (await userIsAdmin(currentUser)) || (await userIsAgent(currentUser));
};

/**
 * Mutates a plain object (toJSON) placement for read-only clients.
 * @param {object} plain
 */
export const stripPlacementPlain = (plain) => {
  if (!plain) return;
  if (plain.backgroundVerification && typeof plain.backgroundVerification === 'object') {
    const { status, requestedAt, completedAt, agency } = plain.backgroundVerification;
    plain.backgroundVerification = { status, requestedAt, completedAt, agency, notes: undefined };
  }
  if (plain.offer && typeof plain.offer === 'object') {
    const o = plain.offer;
    if (o.ctcBreakdown != null) o.ctcBreakdown = undefined;
  }
};

/**
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {import('mongoose').Types.ObjectId|string} actorId
 * @returns {boolean}
 */
export const sameUserId = (userId, actorId) => String(userId || '') === String(actorId || '');

/** Agent not assigned must not read placement (403). */
export const assertAgentCanReadPlacement = async (currentUser, placement) => {
  const httpStatus = (await import('http-status')).default;
  const ApiError = (await import('./ApiError.js')).default;
  const { userIsAdmin, userIsAgent } = await import('./roleHelpers.js');
  if (await userIsAdmin(currentUser)) return;
  if (!(await userIsAgent(currentUser))) return;
  const emp = await Employee.findById(placement.candidate?._id || placement.candidate).lean();
  if (!emp) throw new ApiError(httpStatus.NOT_FOUND, 'Not found');
  const ok = await isAgentViewerAssignedToCandidate(emp, placement.job, currentUser);
  if (!ok) throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
};
