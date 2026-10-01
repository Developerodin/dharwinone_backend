import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import {
  MAX_PEOPLE, CHANNEL_LINE, actionScope, actionDeps, resolveModule, resolvePeople, courseAssignedNotice, plural, nameList,
} from './common.js';

// trainingModule.route.js PATCH /training/modules/:moduleId — requirePermissions('modules.manage').
export const ASSIGN_ACCESS = Object.freeze({ allOf: ['modules.manage'] });

export default defineTool({
  name: 'assign_training',
  domain: 'training',
  kind: 'write',
  description:
    'Draft adding named people to one training course (module). Only drafts: the user must press Confirm. ' +
    'Each person added gets the "Course assigned" notification and email. Nobody already on the course is ' +
    'removed. People must be named one by one (name or email) — never "everyone in a position".',
  input: Joi.object({
    people: Joi.array().items(Joi.string().min(1).max(120)).min(1).max(MAX_PEOPLE).required()
      .description('Names or email addresses of the people to add, one per entry.'),
    module: Joi.string().min(1).max(120).required().description('Course (module) name.'),
  }),
  access: ASSIGN_ACCESS,
  async prepare({ people, module }, ctx) {
    const viewer = actionScope(ctx);
    const deps = actionDeps(ctx);

    const mod = await resolveModule(module, {}, deps);
    if (mod.error) return { ok: false, error: mod.error };
    const found = await resolvePeople(people, viewer, deps);
    if (found.error) return { ok: false, error: found.error };

    const roster = await deps.TrainingModule.findById(mod.module.id).select('students').lean();
    const onCourse = new Set((roster?.students || []).map(String));
    const toAdd = found.students.filter((s) => !onCourse.has(s.studentId));
    const already = found.students.filter((s) => onCourse.has(s.studentId));

    const skipped = [];
    if (already.length) skipped.push(`Skipped — already on the course, not notified again: ${nameList(already)}.`);
    if (found.noProfile.length) {
      skipped.push(`Skipped — no training profile (none will be created): ${nameList(found.noProfile)}.`);
    }
    if (found.inactive.length) skipped.push(`Skipped — training profile not active: ${nameList(found.inactive)}.`);
    if (!toAdd.length) return { ok: false, error: `Nobody to add to "${mod.module.name}". ${skipped.join(' ')}` };

    const notice = courseAssignedNotice(mod.module.name);
    const lines = [
      `Add to "${mod.module.name}": ${nameList(toAdd)}.`,
      CHANNEL_LINE,
      `Message: "${notice.message}" (email subject "${notice.subject}").`,
      ...(mod.module.status && mod.module.status !== 'published' ? [`Note: this course is ${mod.module.status}, not published.`] : []),
      ...skipped,
      'Nobody already on the course is removed or notified.',
    ];
    return {
      ok: true,
      summary: {
        title: `Assign "${mod.module.name}" to ${plural(toAdd.length, 'person', 'people')}`,
        lines,
        targetCount: toAdd.length,
        targets: toAdd.map((s) => ({ id: s.studentId, name: s.name })),
        confirmLabel: 'Assign course',
      },
      payload: { moduleId: mod.module.id, studentIds: toAdd.map((s) => s.studentId) },
    };
  },
  async commit({ payload }, ctx) {
    const deps = actionDeps(ctx);
    const res = await deps.enrollStudentsInModule(payload.moduleId, payload.studentIds, ctx.user);
    const extra = [];
    if (res.alreadyEnrolled.length) extra.push(`${plural(res.alreadyEnrolled.length, 'person was', 'people were')} already on it (not notified)`);
    if (res.notFound.length) extra.push(`${plural(res.notFound.length, 'profile', 'profiles')} no longer exist`);
    return {
      ok: true,
      message: `Assigned the course to ${plural(res.added.length, 'person', 'people')}.${extra.length ? ` ${extra.join('; ')}.` : ''}`,
      details: {
        addedStudentIds: res.added,
        alreadyEnrolledStudentIds: res.alreadyEnrolled,
        notFoundStudentIds: res.notFound,
      },
    };
  },
});
