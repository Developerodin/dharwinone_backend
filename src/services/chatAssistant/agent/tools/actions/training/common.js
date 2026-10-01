import StudentModel from '../../../../../../models/student.model.js';
import UserModel from '../../../../../../models/user.model.js';
import TrainingModuleModel from '../../../../../../models/trainingModule.model.js';
import SageActionModel from '../../../../../../models/sageAction.model.js';
import {
  courseAssignedNotice,
  courseReminderNotice,
  courseReminderEligibility,
  enrollStudentsInModule,
  sendCourseReminder,
} from '../../../../../trainingModule.service.js';
import { escapeRegex, pickByName } from '../../training/common.js';
import { resolveRowScope as realResolveRowScope } from '../../../../toolAccess.js';

export const MAX_PEOPLE = 50;
export const REMINDER_TOOL = 'send_course_reminder';
export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
// Mirrors a notify(type 'course') call: both channels obey the user's course-update settings.
export const CHANNEL_LINE =
  'Channel: in-app notification and email (unless they turned off course updates in their notification settings).';

export function actionScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('training actions need an authenticated user with an id');
  return ctx.user;
}

export function actionDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    Student: deps.Student ?? StudentModel,
    User: deps.User ?? UserModel,
    TrainingModule: deps.TrainingModule ?? TrainingModuleModel,
    SageAction: deps.SageAction ?? SageActionModel,
    enrollStudentsInModule: deps.enrollStudentsInModule ?? enrollStudentsInModule,
    sendCourseReminder: deps.sendCourseReminder ?? sendCourseReminder,
    courseReminderEligibility: deps.courseReminderEligibility ?? courseReminderEligibility,
    resolveRowScope: deps.resolveRowScope ?? realResolveRowScope,
    now: deps.now ?? Date.now,
  };
}

export { courseAssignedNotice, courseReminderNotice };

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const nameList = (items) => items.map((i) => i.name).join(', ');

/**
 * One module by name: exact (case-insensitive) wins, else a unique partial match.
 * `publishedOnly` hides drafts and archived modules, as the module list does for a caller
 * without modules.manage. Anything hidden or missing is refused by the name asked for only.
 */
export async function resolveModule(query, { publishedOnly = false } = {}, deps) {
  const q = String(query).trim();
  const find = (rx) =>
    deps.TrainingModule.find({
      moduleName: { $regex: rx, $options: 'i' },
      ...(publishedOnly ? { status: 'published' } : {}),
    })
      .select('moduleName status')
      .limit(10)
      .lean();
  // Exact name first: an unsorted partial match capped at 10 can miss it.
  let rows = await find(`^${escapeRegex(q)}$`);
  if (!rows.length) rows = await find(escapeRegex(q));
  const pick = pickByName(rows, q, (m) => m.moduleName);
  if (pick.kind === 'notFound') return { error: `No course matches "${q}".` };
  if (pick.items.length > 1) {
    return { error: `Several courses match "${q}": ${pick.items.map((m) => m.moduleName).join(', ')}. Say which one.` };
  }
  const [m] = pick.items;
  return { module: { id: String(m._id), name: m.moduleName, status: m.status ?? null } };
}

/**
 * Explicit people only (names or emails, never a group), resolved the way get_training_progress
 * resolves a person: deleted accounts and, for anyone but a platform super user, platform
 * super accounts are invisible. Any name that is missing or ambiguous refuses the whole draft,
 * naming only what was asked. People with no Student profile come back in `noProfile`, non-active ones in `inactive`;
 * a profile is never created.
 * @returns {Promise<{ error: string } | { students: {studentId, userId, name}[], noProfile: {userId, name}[], inactive: {userId, name}[], outOfScope: {userId, name}[] }>}
 */
export async function resolvePeople(people, viewer, deps) {
  const tokens = [...new Map(people.map((p) => [String(p).trim().toLowerCase(), String(p).trim()])).values()].filter(
    Boolean
  );
  const visible = {
    status: { $ne: 'deleted' },
    ...(viewer.platformSuperUser ? {} : { platformSuperUser: { $ne: true } }),
  };
  const lookup = (field, rx) =>
    deps.User.find({ [field]: { $regex: rx, $options: 'i' }, ...visible })
      .select('name email')
      .limit(6)
      .lean();
  const found = await Promise.all(
    tokens.map(async (token) => {
      const field = token.includes('@') ? 'email' : 'name';
      let users = await lookup(field, `^${escapeRegex(token)}$`);
      if (!users.length && field === 'name') users = await lookup(field, escapeRegex(token));
      return { token, pick: users.length ? pickByName(users, token, (u) => u[field]) : { kind: 'notFound', items: [] } };
    })
  );

  const missing = found.filter((f) => f.pick.kind === 'notFound').map((f) => `"${f.token}"`);
  const ambiguous = found.filter((f) => f.pick.kind !== 'notFound' && f.pick.items.length > 1);
  if (missing.length || ambiguous.length) {
    const parts = [];
    if (missing.length) parts.push(`No one found for ${missing.join(', ')}. Check the spelling or use their email.`);
    for (const f of ambiguous) {
      const options = f.pick.items.map((u) => `${u.name ?? 'Unnamed'} (${u.email ?? 'no email'})`).join(', ');
      parts.push(`Several people match "${f.token}": ${options}. Say which one (use their email).`);
    }
    return { error: parts.join(' ') };
  }

  const users = [...new Map(found.map((f) => [String(f.pick.items[0]._id), f.pick.items[0]])).values()];
  // Same row scope get_training_progress's person lookup sits inside for a scoped viewer
  // (resolveRowScope). students.manage does not widen it: a user this viewer cannot see
  // is out of scope, never addressed.
  const scope = await deps.resolveRowScope(viewer);
  const visibleUsers = [];
  const outOfScope = [];
  for (const u of users) {
    const userId = String(u._id);
    const name = u.name ?? u.email ?? 'Unnamed';
    if (scope && !scope.has(userId)) outOfScope.push({ userId, name });
    else visibleUsers.push(u);
  }
  const students = visibleUsers.length
    ? await deps.Student.find({ user: { $in: visibleUsers.map((u) => u._id) } })
      .select('_id user status')
      .lean()
    : [];
  const studentByUser = new Map(students.map((s) => [String(s.user), s]));
  const out = { students: [], noProfile: [], inactive: [], outOfScope };
  for (const u of visibleUsers) {
    const userId = String(u._id);
    const name = u.name ?? u.email ?? 'Unnamed';
    const student = studentByUser.get(userId);
    if (!student) out.noProfile.push({ userId, name });
    // The course pages only list active students (trainingModule.service queryEmployeesForModule).
    else if (student.status !== 'active') out.inactive.push({ userId, name });
    else out.students.push({ studentId: String(student._id), userId, name });
  }
  return out;
}

/**
 * Student ids already reminded about this module within the last 24 h, from SageAction history
 * (terminal rows live 24 h, so the window is still on file). `sent` is only what a done row
 * recorded in remindedStudentIds — an executing row has not sent anything, so its payload
 * is `inProgress`, never reported as sent. `excludeKey` leaves out the confirm doing the
 * asking. Across every sender, not just this user.
 * ponytail: two confirms claimed in the same instant can both see the other as in progress
 * and both skip the overlap; the upgrade is a unique (moduleId, studentId, day) reminder ledger.
 * No index on tool / payload.moduleId: fine while the collection holds ~a day of drafts.
 * @returns {Promise<{ sent: Set<string>, inProgress: Set<string> }>}
 */
export async function recentlyReminded(moduleId, deps, { includeExecuting = false, excludeKey = null } = {}) {
  const since = new Date(deps.now() - REMINDER_WINDOW_MS);
  const rows = await deps.SageAction.find({
    tool: REMINDER_TOOL,
    'payload.moduleId': String(moduleId),
    status: { $in: includeExecuting ? ['done', 'executing'] : ['done'] },
    confirmedAt: { $gte: since },
    ...(excludeKey ? { key: { $ne: excludeKey } } : {}),
  })
    .select('status payload result')
    .lean();
  const sent = new Set();
  const inProgress = new Set();
  for (const row of rows) {
    if (row.status === 'executing') {
      for (const id of row.payload?.studentIds ?? []) inProgress.add(String(id));
      continue;
    }
    const reminded = row.result?.details?.remindedStudentIds;
    if (!Array.isArray(reminded)) continue;
    for (const id of reminded) sent.add(String(id));
  }
  return { sent, inProgress };
}
