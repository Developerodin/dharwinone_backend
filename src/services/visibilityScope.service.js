import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import User from '../models/user.model.js';
import { userHasRecruiterRole, userIsAdmin, userIsSalesAgent } from '../utils/roleHelpers.js';

const EMPTY_SCOPE = { _id: { $in: [] } };

const toId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value._id || value.id || value);
};

const normalizeEmail = (value) => String(value || '').toLowerCase().trim();

const uniq = (values = []) => [...new Set(values.map((v) => String(v)).filter(Boolean))];

const tenantRootId = (actor = {}) => toId(actor.adminId || actor._id || actor.id);

const tenantScope = (req = {}) => {
  if (!req.tenantId) return {};
  return { tenantId: req.tenantId };
};

/**
 * Build the base tenant filter for a given actor.
 * Prefers the explicit `tenantId` field (P3 migrated) and falls back to `adminId`
 * so queries work correctly during the gradual backfill window.
 *
 * @param {object} actor
 * @returns {{ tenantId?: any } | { adminId?: any }}
 */
const actorTenantBase = (actor = {}) => {
  if (actor.tenantId) return { tenantId: actor.tenantId };
  const rootId = tenantRootId(actor);
  return rootId ? { adminId: rootId } : {};
};

const candidateScope = async (actor = {}, action = 'read') => {
  const actorId = toId(actor._id || actor.id);
  const actorEmail = normalizeEmail(actor.email);
  const admin = await userIsAdmin(actor);
  const salesAgent = !admin && (await userIsSalesAgent(actor));
  const recruiter = !admin && !salesAgent && (await userHasRecruiterRole(actor));

  const base = actorTenantBase(actor);
  if (admin) return { filter: base, scopeDebug: { scopeType: 'candidate', action, role: 'admin' } };

  const or = [];
  if (actorId) or.push({ owner: actorId });
  if (actorEmail) or.push({ email: actorEmail });
  if (salesAgent && actorId) or.push({ referredByUserId: actorId });
  if (recruiter && actorId) or.push({ assignedRecruiter: actorId });
  if (!or.length) return { filter: EMPTY_SCOPE, scopeDebug: { scopeType: 'candidate', action, role: 'none' } };

  return {
    filter: { ...base, $or: or },
    scopeDebug: {
      scopeType: 'candidate',
      action,
      role: salesAgent ? 'sales_agent' : recruiter ? 'recruiter' : 'self',
    },
  };
};

const jobScope = async (actor = {}, action = 'read') => {
  const actorId = toId(actor._id || actor.id);
  const admin = await userIsAdmin(actor);
  const recruiter = !admin && (await userHasRecruiterRole(actor));

  if (recruiter && actorId) {
    return { filter: { createdBy: actorId }, scopeDebug: { scopeType: 'job', action, role: 'recruiter' } };
  }

  if (admin) {
    const base = actorTenantBase(actor);
    if (!Object.keys(base).length) return { filter: {}, scopeDebug: { scopeType: 'job', action, role: 'admin' } };

    // P3: if tenantId field is present use it directly on Job; otherwise fall back to createdBy-in-tenant-users.
    if (base.tenantId) {
      return {
        filter: { tenantId: base.tenantId },
        scopeDebug: { scopeType: 'job', action, role: 'admin' },
      };
    }

    // Legacy: resolve via adminId user tree.
    const rootId = tenantRootId(actor);
    const tenantUsers = await User.find(
      { $or: [{ _id: rootId }, { adminId: rootId }] },
      { _id: 1 }
    ).lean();
    const userIds = uniq(tenantUsers.map((u) => u._id));
    return {
      filter: userIds.length ? { createdBy: { $in: userIds } } : EMPTY_SCOPE,
      scopeDebug: { scopeType: 'job', action, role: 'admin', tenantUsers: userIds.length },
    };
  }

  return { filter: EMPTY_SCOPE, scopeDebug: { scopeType: 'job', action, role: 'none' } };
};

const applicationScope = async (actor = {}, action = 'read') => {
  const actorId = toId(actor._id || actor.id);
  const actorEmail = normalizeEmail(actor.email);
  const admin = await userIsAdmin(actor);
  const recruiter = !admin && (await userHasRecruiterRole(actor));
  const salesAgent = !admin && !recruiter && (await userIsSalesAgent(actor));

  if (admin) {
    return { filter: {}, scopeDebug: { scopeType: 'application', action, role: 'admin' } };
  }

  if (recruiter && actorId) {
    const jobs = await Job.find({ createdBy: actorId }, { _id: 1 }).lean();
    const jobIds = uniq(jobs.map((j) => j._id));
    return {
      filter: jobIds.length ? { job: { $in: jobIds } } : EMPTY_SCOPE,
      scopeDebug: { scopeType: 'application', action, role: 'recruiter', jobCount: jobIds.length },
    };
  }

  const candidateOr = [];
  if (salesAgent && actorId) {
    candidateOr.push({ referredByUserId: actorId });
  } else {
    if (actorId) candidateOr.push({ owner: actorId });
    if (actorEmail) candidateOr.push({ email: actorEmail });
  }

  const candidateRows = candidateOr.length
    ? await Employee.find({ $or: candidateOr }, { _id: 1 }).lean()
    : [];
  const candidateIds = uniq(candidateRows.map((c) => c._id));

  const appOr = [];
  if (candidateIds.length) appOr.push({ candidate: { $in: candidateIds } });
  if (actorId) {
    appOr.push({ appliedBy: actorId }, { applicantUser: actorId });
  }

  return {
    filter: appOr.length ? { $or: appOr } : EMPTY_SCOPE,
    scopeDebug: {
      scopeType: 'application',
      action,
      role: salesAgent ? 'sales_agent' : 'self',
      candidateCount: candidateIds.length,
    },
  };
};

const meetingActorQuery = (actor = {}) => {
  const actorId = toId(actor._id || actor.id);
  const actorEmail = normalizeEmail(actor.email);
  const or = [];
  if (actorId) or.push({ createdBy: actorId });
  if (actorEmail) {
    or.push(
      { 'hosts.email': actorEmail },
      { 'candidate.email': actorEmail },
      { 'recruiter.email': actorEmail },
      { 'agents.email': actorEmail },
      { emailInvites: actorEmail }
    );
  }
  return or.length ? { $or: or } : null;
};

const recordingScope = async (actor = {}, action = 'read') => {
  const admin = await userIsAdmin(actor);
  if (admin) {
    const rootId = tenantRootId(actor);
    if (!rootId) return { filter: {}, scopeDebug: { scopeType: 'recording', action, role: 'admin' } };
    const tenantUsers = await User.find(
      { $or: [{ _id: rootId }, { adminId: rootId }] },
      { _id: 1 }
    ).lean();
    const userIds = uniq(tenantUsers.map((u) => u._id));
    const [mRows, iRows] = await Promise.all([
      Meeting.find({ createdBy: { $in: userIds } }, { meetingId: 1 }).lean(),
      InternalMeeting.find({ createdBy: { $in: userIds } }, { meetingId: 1 }).lean(),
    ]);
    const meetingIds = uniq([...mRows.map((m) => m.meetingId), ...iRows.map((m) => m.meetingId)]);
    return {
      filter: meetingIds.length ? { meetingId: { $in: meetingIds } } : EMPTY_SCOPE,
      scopeDebug: { scopeType: 'recording', action, role: 'admin', meetingCount: meetingIds.length },
    };
  }

  const actorQuery = meetingActorQuery(actor);
  if (!actorQuery) return { filter: EMPTY_SCOPE, scopeDebug: { scopeType: 'recording', action, role: 'none' } };
  const [mRows, iRows] = await Promise.all([
    Meeting.find(actorQuery, { meetingId: 1 }).lean(),
    InternalMeeting.find(actorQuery, { meetingId: 1 }).lean(),
  ]);
  const meetingIds = uniq([...mRows.map((m) => m.meetingId), ...iRows.map((m) => m.meetingId)]);
  return {
    filter: meetingIds.length ? { meetingId: { $in: meetingIds } } : EMPTY_SCOPE,
    scopeDebug: { scopeType: 'recording', action, role: 'self', meetingCount: meetingIds.length },
  };
};

export { tenantScope, candidateScope, jobScope, applicationScope, recordingScope };

export default {
  tenantScope,
  candidateScope,
  jobScope,
  applicationScope,
  recordingScope,
};
