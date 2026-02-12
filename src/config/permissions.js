/**
 * Permission aliases: the string after the first dot in role permissions
 * (e.g. "activity" from "logs.activity") may not exactly match the API endpoint
 * name (e.g. "activityLogs"). This map says "route requires X" → "grant access
 * if user has any of these". Add an entry whenever the API resource name and
 * the permission resource name are similar but not identical.
 */
export const permissionAliases = {
  // Activity logs API: derived permission is "activity.read" (from logs.activity)
  'activityLogs.read': ['activityLogs.read', 'activity.read'],
  'activityLogs.manage': ['activityLogs.manage', 'activity.manage'],
  // Training modules: map to permission format "training.modules:view,create,edit,delete"
  'training.modules.read': ['training.modules.read', 'training.modules:view', 'training.modules:view,create,edit,delete'],
  'training.modules.manage': [
    'training.modules.manage',
    'training.modules:create,edit,delete',
    'training.modules:view,create,edit,delete',
  ],
};

/**
 * Resolve required permission to the list of permission strings that grant access.
 * @param {string} required - e.g. 'activityLogs.read'
 * @returns {string[]} - e.g. ['activityLogs.read', 'activity.read']
 */
export const getGrantingPermissions = (required) => {
  const list = permissionAliases[required];
  return Array.isArray(list) && list.length ? list : [required];
};
