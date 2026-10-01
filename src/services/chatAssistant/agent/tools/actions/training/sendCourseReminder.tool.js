import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import { checkAccessRule } from '../../../../toolAccess.js';
import {
  MAX_PEOPLE, CHANNEL_LINE, REMINDER_TOOL, actionScope, actionDeps, resolveModule, resolvePeople, recentlyReminded,
  courseReminderNotice, plural, nameList,
} from './common.js';

// Course Assignment (modules.manage) or student management (students.manage).
export const REMINDER_ACCESS = Object.freeze({ anyOf: ['modules.manage', 'students.manage'] });

export default defineTool({
  name: REMINDER_TOOL,
  domain: 'training',
  kind: 'write',
  description:
    'Draft a reminder to people the user named, to continue one training course (module). Only drafts: the user must ' +
    'press Confirm. Only people enrolled and not finished get it; completed, not enrolled and anyone reminded ' +
    'about this course in the last 24 hours are skipped. Each person must be named by the user (name or email). ' +
    'Do not call this for everyone, a position, or whoever has not started: look those up, ask which people, and ' +
    'do not copy names from that lookup into this tool. Courses have no due date, so never call it "overdue".',
  input: Joi.object({
    people: Joi.array().items(Joi.string().min(1).max(120)).min(1).max(MAX_PEOPLE).required()
      .description('People the user named in this request, one name or email per entry. Not a whole cohort.'),
    module: Joi.string().min(1).max(120).required().description('Course (module) name.'),
  }),
  access: REMINDER_ACCESS,
  async prepare({ people, module }, ctx) {
    const viewer = actionScope(ctx);
    const deps = actionDeps(ctx);

    const managesModules = (await checkAccessRule({ anyOf: ['modules.manage'] }, viewer)).ok;
    const mod = await resolveModule(module, { publishedOnly: !managesModules }, deps);
    if (mod.error) return { ok: false, error: mod.error };
    const found = await resolvePeople(people, viewer, deps);
    if (found.error) return { ok: false, error: found.error };

    const standing = await deps.courseReminderEligibility(mod.module.id, found.students.map((s) => s.studentId));
    // Only `done` rows: on confirm this draft's own row is executing and must not count against itself.
    const recent = await recentlyReminded(mod.module.id, deps);
    const byId = new Map(found.students.map((s) => [s.studentId, s]));
    const named = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
    const toRemind = named(standing.remind.filter((id) => !recent.has(id)));
    const skipGroups = [
      ['completed the course', named(standing.completed)],
      ['dropped the course', named(standing.dropped)],
      ['not enrolled on the course', named(standing.notEnrolled)],
      ['no training profile', found.noProfile],
      ['training profile not active', found.inactive],
      ['already reminded about this course in the last 24 hours', named(standing.remind.filter((id) => recent.has(id)))],
    ];
    const skipped = skipGroups.filter(([, list]) => list.length).map(([why, list]) => `Skipped — ${why}: ${nameList(list)}.`);
    if (!toRemind.length) return { ok: false, error: `Nobody to remind about "${mod.module.name}". ${skipped.join(' ')}` };

    const notice = courseReminderNotice(mod.module.name);
    return {
      ok: true,
      summary: {
        title: `Remind ${plural(toRemind.length, 'person', 'people')} about "${mod.module.name}"`,
        lines: [
          `Recipients: ${nameList(toRemind)}.`,
          CHANNEL_LINE,
          `Message: "${notice.message}" (email subject "${notice.subject}", with a link to the course list).`,
          ...skipped,
        ],
        targetCount: toRemind.length,
        targets: toRemind.map((s) => ({ id: s.studentId, name: s.name })),
        confirmLabel: 'Send reminder',
      },
      payload: { moduleId: mod.module.id, studentIds: toRemind.map((s) => s.studentId) },
    };
  },
  async commit(draft, ctx) {
    const deps = actionDeps(ctx);
    const { moduleId, studentIds } = draft.payload;
    const recent = await recentlyReminded(moduleId, deps, { includeExecuting: true, excludeKey: draft.key });
    const ids = studentIds.filter((id) => !recent.has(String(id)));
    const recentSkipped = studentIds.filter((id) => recent.has(String(id)));
    if (!ids.length) {
      return {
        ok: true,
        message: 'Nothing sent: everyone on this draft was already reminded about this course in the last 24 hours.',
        details: { remindedStudentIds: [], recentlyRemindedStudentIds: recentSkipped },
      };
    }
    const res = await deps.sendCourseReminder(moduleId, ids, ctx.user);
    const notSent = res.completed.length + res.dropped.length + res.notEnrolled.length + recentSkipped.length;
    return {
      ok: true,
      message: `Sent the reminder to ${plural(res.reminded.length, 'person', 'people')}.` +
        (notSent ? ` ${plural(notSent, 'person was', 'people were')} skipped (finished, not enrolled or already reminded).` : ''),
      details: {
        remindedStudentIds: res.reminded,
        completedStudentIds: res.completed,
        droppedStudentIds: res.dropped,
        notEnrolledStudentIds: res.notEnrolled,
        recentlyRemindedStudentIds: recentSkipped,
      },
    };
  },
});
