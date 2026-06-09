import Employee from '../models/employee.model.js';
import Job from '../models/job.model.js';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';
import User from '../models/user.model.js';
import {
  userCanViewAllInterviewsForListing,
  userHasRecruiterRole,
  userIsAdmin,
  userIsSalesAgent,
} from '../utils/roleHelpers.js';
import { hasApiPermission } from '../utils/permissionCheck.js';

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

  // Matrix-driven bypass: any role granted ATS Interviews → Create/Edit/Delete (resolves to
  // `interviews.manage`) can read ALL job applications. Needed so interview schedulers see
  // candidates' applied jobs even when they don't own the candidate / job. Toggle via the
  // user role matrix (Interviews row → Create or Edit or Delete).
  if (await hasApiPermission(actor, 'interviews.manage')) {
    return {
      filter: {},
      scopeDebug: { scopeType: 'application', action, role: 'permission:interviews.manage' },
    };
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

/**
 * Collect all user ids in a tenant tree (root + nested adminId descendants).
 * @param {import('mongoose').Types.ObjectId|string} rootId
 * @returns {Promise<string[]>}
 */
const resolveTenantUserIds = async (rootId) => {
  if (!rootId) return [];
  const ids = new Set([String(rootId)]);
  let frontier = [rootId];
  for (let depth = 0; depth < 10 && frontier.length; depth += 1) {
    const children = await User.find({ adminId: { $in: frontier } }, { _id: 1 }).lean();
    const next = [];
    for (const child of children) {
      const id = String(child._id);
      if (!ids.has(id)) {
        ids.add(id);
        next.push(child._id);
      }
    }
    frontier = next;
  }
  return [...ids];
};

/**
 * Tenant-wide meeting filter: stamped tenantId OR any creator in the tenant user tree.
 * @param {import('mongoose').Types.ObjectId|string} rootId
 * @returns {Promise<object>}
 */
const tenantMeetingFilter = async (rootId) => {
  if (!rootId) return {};
  const userIds = await resolveTenantUserIds(rootId);
  const orClauses = [{ tenantId: rootId }];
  if (userIds.length) orClauses.push({ createdBy: { $in: userIds } });
  return { $or: orClauses };
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
    // Union of three clauses for admin visibility:
    //   1. tenant-stamped rows (new path — recording creation sets tenantId)
    //   2. meetingId matches a Meeting/InternalMeeting in this tenant (legacy)
    //   3. orphan rows with no tenantId AND no parent Meeting row — surfaced to
    //      every admin as ops-view. recordingDiscovery cron inserts rows with
    //      `meetingId: info.roomName || 'unknown'` for egresses started outside
    //      our app; older rows pre-date the tenantId field. Without clause 3
    //      these recordings stayed permanently invisible despite the S3 file
    //      existing. Multi-admin leak risk is none — orphan rows have no
    //      tenant attribution by definition.
    const orphanMeetingIdClause = meetingIds.length
      ? { meetingId: { $nin: meetingIds } }
      : {};
    const filterClauses = [
      { tenantId: rootId },
      ...(meetingIds.length ? [{ meetingId: { $in: meetingIds } }] : []),
      { tenantId: { $in: [null, undefined] }, ...orphanMeetingIdClause },
    ];
    return {
      filter: { $or: filterClauses },
      scopeDebug: { scopeType: 'recording', action, role: 'admin', meetingCount: meetingIds.length, tenantRoot: String(rootId) },
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

/**
 * Build a Mongoose filter restricting Meeting docs to those an actor may see.
 * Admins see every meeting created by a user in their tenant tree; non-admins
 * see meetings they created, host, recruit, are the candidate of, or are invited
 * to. Used to scope by-id reads/writes so meetings can't be enumerated cross-tenant.
 *
 * @param {Object} actor - req.user
 * @param {'read'|'write'} action
 * @returns {Promise<{ filter: object }>}
 */
const meetingScope = async (actor = {}, action = 'read') => {
  if (await userCanViewAllInterviewsForListing(actor)) {
    const rootId = tenantRootId(actor);
    if (!rootId) {
      return { filter: {}, scopeDebug: { scopeType: 'meeting', action, role: 'interview_listing_global' } };
    }
    return {
      filter: await tenantMeetingFilter(rootId),
      scopeDebug: { scopeType: 'meeting', action, role: 'interview_listing', tenantRoot: String(rootId) },
    };
  }

  const actorQuery = meetingActorQuery(actor);
  return {
    filter: actorQuery || EMPTY_SCOPE,
    scopeDebug: { scopeType: 'meeting', action, role: actorQuery ? 'self' : 'none' },
  };
};

/**
 * Restrict Employee reads for organization surfaces to the actor's tenant boundary.
 * OrgUnit/Department catalogs remain deployment-global; employee rows are tenant-scoped.
 *
 * @param {object} actor
 * @returns {Promise<{ filter: object, scopeDebug: object }>}
 */
const orgEmployeeScope = async (actor = {}) => {
  const admin = await userIsAdmin(actor);
  const base = actorTenantBase(actor);
  if (admin) {
    return {
      filter: Object.keys(base).length ? base : {},
      scopeDebug: { scopeType: 'orgEmployee', role: 'admin' },
    };
  }
  if (Object.keys(base).length) {
    return { filter: base, scopeDebug: { scopeType: 'orgEmployee', role: 'tenant' } };
  }
  return { filter: {}, scopeDebug: { scopeType: 'orgEmployee', role: 'global' } };
};

export {
  tenantScope,
  candidateScope,
  jobScope,
  applicationScope,
  recordingScope,
  meetingScope,
  orgEmployeeScope,
};

export default {
  tenantScope,
  candidateScope,
  jobScope,
  applicationScope,
  recordingScope,
  meetingScope,
  orgEmployeeScope,
};
