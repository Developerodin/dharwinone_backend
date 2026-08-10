import { userIsAdmin, userIsAgent, userIsSalesAgent } from '../../utils/roleHelpers.js';

function hasFullEmployeeCrud(authContext) {
  const p = authContext?.permissions;
  if (!p) return false;
  return (
    p.has('employees.read')
    && p.has('employees.create')
    && p.has('employees.edit')
    && p.has('employees.delete')
  );
}

/** Mirror `employee.controller.js` canViewAllEmployees — authContext-only variant. */
function canViewAllEmployees(authContext) {
  const p = authContext?.permissions;
  if (!p) return false;
  return (
    p.has('employees.read')
    || p.has('candidates.read')
    || p.has('candidates.manage')
    || p.has('employees.manage')
  );
}

/**
 * Convert canonical StructuredQuery filters to queryCandidates API filter shape.
 * agentIds array → comma-separated string (legacy REST API).
 */
export function toApiFilter(filters = {}) {
  if (!filters || typeof filters !== 'object') {
    return {};
  }

  const apiFilter = { ...filters };
  if (Array.isArray(apiFilter.agentIds)) {
    apiFilter.agentIds = apiFilter.agentIds.map(String).filter(Boolean).join(',');
  }
  // The StructuredQuery says `id`; buildEmployeeListMongoFilter reads `ids`.
  // Without this the narrowing evaporates and the full scoped roster is returned.
  if (apiFilter.id) {
    apiFilter.ids = [String(apiFilter.id)];
    delete apiFilter.id;
  }
  return apiFilter;
}

/**
 * Apply server-side list scoping — mirrors `employee.controller.js` list handler (~255–278).
 *
 * @param {object} filter - API filter shape (post toApiFilter)
 * @param {object} user
 * @param {object} authContext - req.authContext
 * @param {{ userIsAdmin?: Function, userIsAgent?: Function, userIsSalesAgent?: Function }} [deps] - test overrides
 */
export async function applyEmployeeListScope(filter, user, authContext, deps = {}) {
  const scoped = { ...(filter || {}) };
  const checkAdmin = deps.userIsAdmin ?? userIsAdmin;
  const checkAgent = deps.userIsAgent ?? userIsAgent;
  const checkSalesAgent = deps.userIsSalesAgent ?? userIsSalesAgent;

  if (user?.platformSuperUser) {
    return scoped;
  }

  const isAdmin = await checkAdmin(user);
  if (!isAdmin && !hasFullEmployeeCrud(authContext)) {
    const isAgent = await checkAgent(user);
    const isSalesAgent = await checkSalesAgent(user);
    if (isAgent) {
      scoped.agentIds = String(user._id);
    } else if (isSalesAgent) {
      scoped.salesAgentScopeUserId = String(user._id);
    } else if (!canViewAllEmployees(authContext)) {
      scoped.owner = user._id;
    }
  }

  return scoped;
}
