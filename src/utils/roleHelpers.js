import Role from '../models/role.model.js';

/**
 * Staff / internal roles: if the user has any of these (active), skip public-candidate auto-activate on email verify.
 * Single enumeration for D-02 — keep in sync with product definition of "internal account".
 * ('agent' lowercase matches legacy DB rows; see userIsAgent.)
 */
/** ATS referral leads: scoped to own `referredByUserId` only; no org-wide list / override. */
export const SALES_AGENT_ROLE_NAME = 'sales_agent';

/** DB / UI variants that denote the same sales-agent role (canonical name is {@link SALES_AGENT_ROLE_NAME}). */
export const SALES_AGENT_ROLE_NAMES = [SALES_AGENT_ROLE_NAME, 'Sales Agent'];

export const STAFF_ROLE_NAMES_SKIP_PUBLIC_CANDIDATE_VERIFY = [
  'Administrator',
  'Agent',
  'agent',
  'Employee',
  'Manager',
  'Mentor',
  'Recruiter',
  ...SALES_AGENT_ROLE_NAMES,
];

/**
 * @param {Object|null|undefined} user - User with roleIds
 * @returns {Promise<boolean>}
 */
export const userIsSalesAgent = async (user) => {
  if (!user) return false;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({
    _id: { $in: roleIds },
    name: { $in: SALES_AGENT_ROLE_NAMES },
    status: 'active',
  });
  return !!hasRole;
};

/**
 * Check if user has Administrator role (by roleIds).
 * @param {Object} user - User object with roleIds
 * @returns {Promise<boolean>}
 */
export const userIsAdmin = async (user) => {
  if (user?.platformSuperUser) return true;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({ _id: { $in: roleIds }, name: 'Administrator', status: 'active' });
  return !!hasRole;
};

/**
 * Check if user has Agent role (by roleIds).
 * @param {Object} user - User object with roleIds
 * @returns {Promise<boolean>}
 */
export const userIsAgent = async (user) => {
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({
    _id: { $in: roleIds },
    $or: [{ name: 'Agent' }, { name: 'agent' }],
    status: 'active',
  });
  return !!hasRole;
};

/**
 * Check if user has Administrator or Agent role (by roleIds).
 * Common helper for services that grant access to both admins and agents.
 * @param {Object} user - User object with roleIds
 * @returns {Promise<boolean>}
 */
export const userIsAdminOrAgent = async (user) => {
  if (user?.platformSuperUser) return true;
  const roleIds = user?.roleIds || [];
  if (roleIds.length === 0) return false;
  const role = await Role.findOne(
    { _id: { $in: roleIds }, name: { $in: ['Administrator', 'Agent'] }, status: 'active' }
  );
  return !!role;
};

/** Role names that Agents are not allowed to assign (Administrator, Agent, Manager, Sales Agent). */
const RESTRICTED_ROLE_NAMES_FOR_AGENT = ['Administrator', 'Agent', 'Manager', ...SALES_AGENT_ROLE_NAMES];

/**
 * When the requester is an Agent, roleIds must not include Administrator, Agent, Manager, or sales_agent.
 * @param {string[]} roleIds - Role IDs being assigned
 * @returns {Promise<{ allowed: boolean, restrictedNames?: string[] }>}
 */
export const validateRoleIdsForAgent = async (roleIds) => {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return { allowed: true };
  const roles = await Role.find({ _id: { $in: roleIds }, status: 'active' }).select('name').lean();
  const restricted = roles.filter((r) => RESTRICTED_ROLE_NAMES_FOR_AGENT.includes(r.name)).map((r) => r.name);
  if (restricted.length === 0) return { allowed: true };
  return { allowed: false, restrictedNames: [...new Set(restricted)] };
};

/**
 * Check if user has the Employee user role (by roleIds), including legacy "Candidate" role name.
 * @param {Object} user - User object with roleIds
 * @returns {Promise<boolean>}
 */
export const userHasCandidateRole = async (user) => {
  if (!user) return false;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({
    _id: { $in: roleIds },
    name: { $in: ['Employee', 'Candidate'] },
    status: 'active',
  });
  return !!hasRole;
};

/**
 * Check if user has Recruiter role (by roleIds).
 * @param {Object} user - User object with roleIds
 * @returns {Promise<boolean>}
 */
export const userHasRecruiterRole = async (user) => {
  if (!user) return false;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({ _id: { $in: roleIds }, name: 'Recruiter', status: 'active' });
  return !!hasRole;
};

/** Role names that may list/view all ATS jobs (tenant-wide), not only jobs they created. */
const ATS_JOB_FULL_LISTING_ROLE_NAMES = ['Administrator', 'Agent', 'agent', 'Recruiter'];

/**
 * True for Administrator, Agent, or Recruiter (routes still require jobs.read / jobs.manage as appropriate).
 * Used so non-poster staff are not limited to createdBy-only job lists.
 * @param {Object|null|undefined} user
 * @returns {Promise<boolean>}
 */
export const userCanViewAllJobsForListing = async (user) => {
  if (!user) return false;
  if (user.platformSuperUser) return true;
  const roleIds = user?.roleIds || [];
  if (!roleIds.length) return false;
  const hasRole = await Role.exists({
    _id: { $in: roleIds },
    name: { $in: ATS_JOB_FULL_LISTING_ROLE_NAMES },
    status: 'active',
  });
  return !!hasRole;
};
