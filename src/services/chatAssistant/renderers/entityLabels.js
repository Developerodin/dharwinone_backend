// Table/card titles from resolved business entity type — not Mongo collection names.

/**
 * @param {object} opts
 * @param {string|null} [opts.entityType]   'user' | 'employee' | 'role' | ...
 * @param {string|null} [opts.role]       Resolved role display name
 * @param {number} [opts.total]
 * @param {string|null} [opts.personName] Single-match person name
 * @param {boolean} [opts.isPersonSearch] Name search, not role headcount
 */
export function buildEntityTableTitle({
  entityType = null,
  role = null,
  total = 0,
  personName = null,
  isPersonSearch = false,
}) {
  const n = Number(total) || 0;

  // Role-scoped directory counts/lists — never collapse to a single person's name.
  if (role && !isPersonSearch) {
    return `${role}s (${n})`;
  }

  if (isPersonSearch || entityType === 'user') {
    if (n === 1 && personName) return personName;
    return `Users (${n})`;
  }

  if (entityType === 'employee' || !entityType) {
    return `Employees (${n})`;
  }

  return `Records (${n})`;
}

/**
 * Infer entityType for renderer ctx from fetch payload metadata.
 * @param {object} data
 */
export function entityTypeFromFetchPayload(data) {
  if (data?.entityType) return data.entityType;
  if (data?.isPersonSearch) return 'user';
  const role = data?.requestedRole;
  if (role && !/^(employee|candidate)$/i.test(role)) return 'user';
  if (role) return 'employee';
  return null;
}

/**
 * @param {string|null} role
 */
export function tableTypeForEntity(role, entityType = null) {
  if (entityType === 'user') return 'users';
  const k = String(role || '').toLowerCase();
  if (k === 'agent' || k === 'salesagent') return 'agents';
  if (k === 'recruiter') return 'recruiters';
  if (k === 'candidate') return 'candidates';
  if (k === 'student') return 'students';
  if (k === 'administrator') return 'users';
  if (k === 'employee') return 'employees';
  if (entityType === 'employee') return 'employees';
  return 'people';
}
