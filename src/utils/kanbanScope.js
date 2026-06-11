/**
 * Kanban matrix view-only: user may open the board but only for work assigned to them.
 * Excludes admin, kanban manage, and broader project.tasks / project.projects read grants.
 *
 * @param {Set<string>} apiPermissions
 * @param {boolean} isAdmin
 * @returns {boolean}
 */
export const isKanbanViewOnlyScope = (apiPermissions, isAdmin) => {
  if (isAdmin) return false;
  const perms = apiPermissions instanceof Set ? apiPermissions : new Set();
  const hasKanbanRead = perms.has('kanban.read') || perms.has('kanban.manage');
  if (!hasKanbanRead) return false;
  if (perms.has('kanban.manage')) return false;
  if (perms.has('tasks.read') || perms.has('tasks.manage')) return false;
  if (perms.has('projects.read') || perms.has('projects.manage')) return false;
  return true;
};
