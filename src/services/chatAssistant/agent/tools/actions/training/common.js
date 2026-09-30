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
  const rows = await deps.TrainingModule.find({
    moduleName: { $regex: escapeRegex(q), $options: 'i' },
    ...(publishedOnly ? { status: 'published' } : {}),
  })
    .select('moduleName status')
    .limit(10)
    .lean();
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
 * naming only what was asked. People with no Student profile come back in `noProfile`;
 * a profile is never created.
 * @returns {Promise<{ error: string } | { students: {studentId, userId, name}[], noProfile: {userId, name}[] }>}
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
  const students = await deps.Student.find({ user: { $in: users.map((u) => u._id) } })
    .select('_id user')
    .lean();
  const studentByUser = new Map(students.map((s) => [String(s.user), String(s._id)]));
  const out = { students: [], noProfile: [] };
  for (const u of users) {
    const userId = String(u._id);
    const name = u.name ?? u.email ?? 'Unnamed';
    const studentId = studentByUser.get(userId);
    if (studentId) out.students.push({ studentId, userId, name });
    else out.noProfile.push({ userId, name });
  }
  return out;
}

/**
 * Student ids already reminded about this module within the last 24 h, from SageAction history
 * (terminal rows live 24 h, so the window is still on file). `done` rows count what commit
 * actually sent; `executing` rows (another confirm mid-send) count their whole payload.
 * `excludeKey` leaves out the confirm doing the asking. Across every sender, not just this user.
 * ponytail: two confirms claimed in the same instant can both send — each sees the other only
 * once it is executing; the upgrade is a unique (moduleId, studentId, day) reminder ledger.
 * No index on tool / payload.moduleId: fine while the collection holds ~a day of drafts.
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
  const ids = new Set();
  for (const row of rows) {
    const sent = (row.status === 'done' && row.result?.details?.remindedStudentIds) || row.payload?.studentIds;
    for (const id of sent ?? []) ids.add(String(id));
  }
  return ids;
}
