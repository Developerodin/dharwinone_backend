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
  // Training modules / modules: route uses "modules.manage", permission may be "training.modules.manage"
  'modules.read': ['modules.read', 'training.modules.read', 'training.modules:view', 'training.modules:view,create,edit,delete'],
  'modules.manage': [
    'modules.manage',
    'training.modules.manage',
    'training.modules:create,edit,delete',
    'training.modules:view,create,edit,delete',
  ],
  'training.modules.read': ['training.modules.read', 'training.modules:view', 'training.modules:view,create,edit,delete'],
  'training.modules.manage': [
    'training.modules.manage',
    'training.modules:create,edit,delete',
    'training.modules:view,create,edit,delete',
  ],
  // Student courses: permission.service derives candidate.courses:view → courses.read (resource = "courses").
  // So authContext.permissions has "courses.read" / "courses.manage", not "candidate.courses:view".
  'students.courses.read': ['students.courses.read', 'students.read', 'students.manage', 'courses.read', 'courses.manage'],
  'students.courses.manage': ['students.courses.manage', 'students.manage', 'courses.manage', 'courses.read'],
  'students.quizzes.take': [
    'students.quizzes.take',
    'students.courses.read',
    'students.courses.manage',
    'courses.read',
    'courses.manage',
  ],
  // Training analytics: allow modules.read / training.modules so analytics page is available to training users
  'training.analytics': ['training.analytics', 'training.analytics:view', 'training.modules.read', 'modules.read'],
  // Attendance: students access their own via requireAttendanceAccess (ownership); grant so Student role can see attendance nav
  'training.attendance.read': ['training.attendance.read', 'training.attendance:view', 'students.read', 'students.manage'],
  // ATS candidates: ats.candidates:view -> candidates.read, ats.candidates:create,edit,delete -> candidates.manage
  'candidates.read': ['candidates.read', 'ats.candidates:view', 'ats.candidates:view,create,edit,delete'],
  'candidates.manage': ['candidates.manage', 'ats.candidates:view,create,edit,delete'],
  // ATS analytics: derived permission is analytics.read; admins/recruiters with ATS access also get in
  'ats.analytics': [
    'ats.analytics',
    'ats.analytics:view',
    'ats.analytics:view,export',
    'analytics.read',
    'candidates.read',
    'candidates.manage',
    'jobs.read',
    'jobs.manage',
    'users.manage',
  ],
  // LiveKit meetings: allow mentors and admins to record meetings
  'meetings.record': ['meetings.record', 'meetings:record', 'mentors.manage', 'training.manage'],
  // ATS offers: map ats.offers:* to candidates (offers are part of ATS pipeline)
  'offers.read': ['offers.read', 'ats.offers:view', 'ats.offers:view,create,edit,delete', 'candidates.read', 'candidates.manage'],
  'offers.manage': ['offers.manage', 'ats.offers:create,edit,delete', 'ats.offers:view,create,edit,delete', 'candidates.manage'],
  // Meetings (communication.meetings)
  'meetings.read': ['meetings.read', 'communication.meetings:view', 'communication.meetings:view,create,edit,delete'],
  'meetings.manage': ['meetings.manage', 'communication.meetings:create,edit,delete', 'communication.meetings:view,create,edit,delete'],
  // Calls (bolna, communication) - from communication.calling
  'calls.read': ['calls.read', 'communication.calling:view', 'communication.calling:view,create,edit,delete'],
  'calls.manage': ['calls.manage', 'communication.calling:create,edit,delete', 'communication.calling:view,create,edit,delete'],
  // Teams (project.teams covers team + teamGroup)
  'teams.read': ['teams.read', 'project.teams:view', 'project.teams:view,create,edit,delete'],
  'teams.manage': ['teams.manage', 'project.teams:create,edit,delete', 'project.teams:view,create,edit,delete'],
  // Recruiters
  'recruiters.read': ['recruiters.read', 'ats.recruiters:view', 'ats.recruiters:view,create,edit,delete'],
  'chats.read': ['chats.read', 'communication.chats:view', 'communication.chats:view,create,edit,delete'],
  'chats.manage': ['chats.manage', 'communication.chats:create,edit,delete', 'communication.chats:view,create,edit,delete'],
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
