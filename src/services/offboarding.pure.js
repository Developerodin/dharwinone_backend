const idOf = (u) => String((u && (u._id ?? u.id)) ?? u);

/**
 * Pure reassignment: drop `fromUserId` from assignedTo, add `toUserIds` (deduped),
 * and append a history entry when the departing user was actually assigned.
 * @returns {{ assignedTo: string[], formerAssignees: Array, changed: boolean }}
 */
export const applyReassign = (task, fromUserId, toUserIds, reason, now) => {
  const from = String(fromUserId);
  const current = (task.assignedTo || []).map(idOf);
  const had = current.includes(from);
  const assignedTo = current.filter((id) => id !== from);
  for (const t of (toUserIds || []).map(String)) {
    if (!assignedTo.includes(t)) assignedTo.push(t);
  }
  const formerAssignees = [...(task.formerAssignees || [])];
  if (had) formerAssignees.push({ user: from, removedAt: now, reason });
  return { assignedTo, formerAssignees, changed: had };
};

export const OFFBOARDING_CHECKER_KEYS = [
  'attendance_complete',
  'email_deactivated',
  'tasks_reassigned',
  'org_team_disabled',
];

export const DEFAULT_OFFBOARDING_STEPS = () => [
  {
    checkerKey: 'attendance_complete',
    label: 'Attendance reconciled',
    description: 'No pending backdated-attendance requests for the tenure.',
    sortOrder: 0,
    enabled: true,
    linkTemplate: '/settings/attendance',
  },
  {
    checkerKey: 'email_deactivated',
    label: 'Deactivate professional email',
    description: 'Revoke the company-assigned email account.',
    sortOrder: 1,
    enabled: true,
    linkTemplate: '',
  },
  {
    checkerKey: 'tasks_reassigned',
    label: 'Reassign tasks',
    description: 'Move open tasks to other owners; their contribution stays on record.',
    sortOrder: 2,
    enabled: true,
    linkTemplate: '',
  },
  {
    checkerKey: 'org_team_disabled',
    label: 'Remove from org tree & teams',
    description: 'Org node drops automatically on the last working day; team memberships are archived.',
    sortOrder: 3,
    enabled: true,
    linkTemplate: '',
  },
];

const DECIDERS = {
  attendance_complete: ({ pendingBackdatedCount }) => (pendingBackdatedCount || 0) === 0,
  email_deactivated: ({ hasCompanyEmail, emailStatus }) => !hasCompanyEmail || emailStatus !== 'active',
  tasks_reassigned: ({ openAssignedTaskCount }) => (openAssignedTaskCount || 0) === 0,
  org_team_disabled: ({ employeeIsActive, activeTeamRowCount }) =>
    employeeIsActive === false && (activeTeamRowCount || 0) === 0,
};

/**
 * Evaluate enabled steps against a plain context object. Pure — no DB.
 * Unknown checkerKeys resolve to done:false (defensive against stale config rows).
 */
export const evaluateSteps = (steps, ctx) =>
  [...(steps || [])]
    .filter((s) => s.enabled !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((s) => {
      const fn = DECIDERS[s.checkerKey];
      return { ...s, done: fn ? Boolean(fn(ctx)) : false };
    });
