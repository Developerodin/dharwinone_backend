import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import StudentModel from '../../../../../models/student.model.js';
import UserModel from '../../../../../models/user.model.js';
import { queryStudentCourses as realQueryStudentCourses } from '../../../../studentCourseQuery.service.js';
import { canReadOtherTraining } from '../../../toolAccess.js';

const MAX_COURSES = 50;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function trainingScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('training tools need an authenticated user with an id');
  return ctx.user;
}

function trainingDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    Student: deps.Student ?? StudentModel,
    User: deps.User ?? UserModel,
    queryStudentCourses: deps.queryStudentCourses ?? realQueryStudentCourses,
    canReadOtherTraining: deps.canReadOtherTraining ?? canReadOtherTraining,
  };
}

/**
 * Course progress lives on Student profiles only (StudentCourseProgress.student → Student.user → User);
 * there is no link from a Candidate/Employee profile. A person without a Student profile has no
 * training data — say so, never "0 courses". Rows come from queryStudentCourses, the service behind
 * the portal's My Courses page (GET /students/:studentId/courses, students.courses.read).
 */
export default defineTool({
  name: 'get_training_progress',
  domain: 'training',
  kind: 'read',
  description:
    'Training (LMS) course progress for the signed-in user (person omitted) or one named person: each assigned ' +
    'module with its status and % complete. Use for "my courses", "how far am I in my training", "which ' +
    'courses has Priya completed". status narrows the list ("completed", "in-progress").',
  measure:
    'Training modules ASSIGNED to one person\'s Student profile (the My Courses page), by enrollment status; ' +
    'a module never opened counts as enrolled at 0%.',
  input: Joi.object({
    person: Joi.string().min(1).max(120).description('Name or email of another person. Omit for the signed-in user.'),
    status: Joi.string().valid('enrolled', 'in-progress', 'completed', 'dropped'),
    limit: Joi.number().integer().min(1).max(MAX_COURSES).default(25),
  }),
  access: { anyOf: ['students.courses.read', 'students.read', 'students.manage'] },
  async execute({ person, status, limit = 25 } = {}, ctx) {
    const user = trainingScope(ctx);
    const deps = trainingDeps(ctx);
    const selfId = String(user.id ?? user._id);
    let userId = selfId;
    let name = user.name ?? null;

    if (person) {
      const rx = { $regex: escapeRegex(person.trim()), $options: 'i' };
      const users = await deps.User.find({
        $or: [{ name: rx }, { email: rx }],
        status: { $ne: 'deleted' },
        ...(user.platformSuperUser ? {} : { platformSuperUser: { $ne: true } }),
      }).select('name email').limit(6).lean();
      if (users.length !== 1) {
        return { searchedFor: person, matches: users.map((u) => ({ name: u.name ?? null, email: u.email ?? null })) };
      }
      userId = String(users[0]._id);
      name = users[0].name ?? null;
      if (userId !== selfId && !(await deps.canReadOtherTraining(user))) {
        return { error: "Viewing another person's training progress needs students.read." };
      }
    }

    const student = await deps.Student.findOne({ user: userId }).select('_id').lean();
    if (!student) {
      return {
        person: name, self: userId === selfId, noStudentProfile: true,
        note: 'No Student profile, so no training/course data is tracked for this person.',
      };
    }
    const page = await deps.queryStudentCourses(String(student._id), status ? { status } : {}, { limit, page: 1 });
    return {
      person: name,
      self: userId === selfId,
      total: page?.totalResults ?? 0,
      ...(status ? { status } : {}),
      courses: (page?.results || []).map((r) => ({
        module: r.module?.moduleName ?? null,
        status: r.status ?? 'enrolled',
        percentage: r.progress?.percentage ?? 0,
        enrolledAt: r.enrolledAt ?? null,
        completedAt: r.completedAt ?? null,
      })),
    };
  },
  render(result) {
    if (!result || result.error || result.matches || result.noStudentProfile) return null;
    return {
      blocks: result.courses.length ? [{
        type: 'table',
        id: 'training-progress',
        tableType: 'training-progress',
        title: `Training${result.person ? ` — ${result.person}` : ''} (${result.total})`,
        columns: [
          { key: 'module', label: 'Module', priority: 'primary' },
          { key: 'status', label: 'Status', priority: 'primary' },
          { key: 'percentage', label: '% done', priority: 'primary' },
        ],
        rows: result.courses.map((c) => ({ module: c.module ?? '—', status: c.status, percentage: `${c.percentage}%` })),
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'get_training_progress', label: 'courses', total: result.total }] },
    };
  },
});
