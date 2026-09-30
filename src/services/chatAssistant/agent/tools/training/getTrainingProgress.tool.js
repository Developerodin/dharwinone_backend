import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  TRAINING_ACCESS, PERSON_ACCESS, COHORT_ACCESS, ROSTER_ACCESS, MAX_LIST_LIMIT,
  escapeRegex, trainingScope, trainingDeps, allowed,
} from './common.js';
import { runCohort, runPositionMap } from './cohort.js';

const denied = (rule) => ({ error: `Not allowed: requires one of ${rule.anyOf.join(', ')}.` });

/**
 * Course progress lives on Student profiles only (StudentCourseProgress.student → Student.user → User);
 * there is no link from a Candidate/Employee profile. A person without a Student profile has no
 * training data — say so, never "0 courses". Rows come from queryStudentCourses, the service behind
 * the portal's My Courses page (GET /students/:studentId/courses, students.courses.read).
 */
async function runPerson({ person, status, limit }, user, deps) {
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
}

export default defineTool({
  name: 'get_training_progress',
  domain: 'training',
  kind: 'read',
  description:
    'Training (LMS) course progress. mode person (default): the signed-in user (person omitted) or one named ' +
    'person — each assigned module with status and % complete ("my courses", "which courses has Priya ' +
    'completed"). mode cohort: everyone on a course and/or position (Training Evaluation page) — completion ' +
    'rate, not started / in progress / completed (progress), quiz score bands (scoreBand gte90, lt70, or custom ' +
    'with minScore/maxScore), inactive for N days (inactiveDays), last accessed, and employees with NO Student ' +
    'profile. mode position_map: which courses and folders each position is assigned.',
  measure:
    'person: modules ASSIGNED to one person\'s Student profile (My Courses), a module never opened counts as ' +
    'enrolled at 0%. cohort: student-course assignments of active students on the Training Evaluation page; ' +
    'quiz score = average graded quiz %. position_map: positions on the Curriculum Setup roster.',
  input: Joi.object({
    mode: Joi.string().valid('person', 'cohort', 'position_map').default('person'),
    person: Joi.string().min(1).max(120).description('mode person: name or email of another person. Omit for self.'),
    status: Joi.string().valid('enrolled', 'in-progress', 'completed', 'dropped').description('mode person only.'),
    course: Joi.string().min(1).max(120).description('mode cohort: course (module) name.'),
    position: Joi.string().min(1).max(120).description('mode cohort / position_map: position name, e.g. "Java Developer".'),
    progress: Joi.string().valid('not_started', 'in_progress', 'completed').description('mode cohort.'),
    scoreBand: Joi.string().valid('gte90', 'lt70', 'custom').description('mode cohort: quiz score band.'),
    minScore: Joi.number().min(0).max(100).description('scoreBand custom: lowest score, inclusive.'),
    maxScore: Joi.number().min(0).max(100).description('scoreBand custom: highest score, inclusive.'),
    inactiveDays: Joi.number().integer().min(1).max(365)
      .description('mode cohort: unfinished courses not opened (or never opened since enrolment) on any of the ' +
        'last N whole IST days, today included.'),
    overdue: Joi.boolean().description('mode cohort: asked for overdue training. Not captured — see the result note.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: TRAINING_ACCESS,
  async execute(args = {}, ctx) {
    const user = trainingScope(ctx);
    const deps = trainingDeps(ctx);
    const { mode = 'person', limit = 20 } = args;

    if (mode === 'cohort') {
      if (!(await allowed(COHORT_ACCESS, user))) return denied(COHORT_ACCESS);
      return runCohort({ ...args, limit }, user, deps);
    }
    if (mode === 'position_map') {
      if (!(await allowed(ROSTER_ACCESS, user))) return denied(ROSTER_ACCESS);
      return runPositionMap({ position: args.position, limit }, deps);
    }
    if (!(await allowed(PERSON_ACCESS, user))) return denied(PERSON_ACCESS);
    return runPerson({ person: args.person, status: args.status, limit }, user, deps);
  },
  render(result) {
    if (!result || result.error || result.matches || result.noStudentProfile || result.notFound) return null;
    if (result.mode === 'cohort') {
      return {
        blocks: result.records.length ? [{
          type: 'table',
          id: 'training-cohort',
          tableType: 'training-cohort',
          title: `Training — ${result.course ?? result.position ?? 'all courses'} (${result.total})`,
          columns: [
            { key: 'student', label: 'Student', priority: 'primary' },
            { key: 'course', label: 'Course', priority: 'primary' },
            { key: 'status', label: 'Status', priority: 'primary' },
            { key: 'completion', label: '% done', priority: 'primary' },
            { key: 'quizScore', label: 'Quiz %', priority: 'secondary' },
          ],
          rows: result.records.map((r) => ({
            student: r.student ?? '—',
            course: r.course ?? '—',
            status: r.status ?? '—',
            completion: `${r.completion}%`,
            quizScore: r.quizScore == null ? '—' : `${r.quizScore}%`,
          })),
          layout: 'auto',
        }] : [],
        facts: { counts: [{ kind: 'get_training_progress', label: 'students', total: result.students }] },
      };
    }
    if (result.mode === 'position_map') {
      return {
        blocks: result.records.length ? [{
          type: 'table',
          id: 'training-position-map',
          tableType: 'training-position-map',
          title: `Positions and courses (${result.total})`,
          columns: [
            { key: 'position', label: 'Position', priority: 'primary' },
            { key: 'courses', label: 'Courses', priority: 'primary' },
            { key: 'folders', label: 'Folders', priority: 'secondary' },
          ],
          rows: result.records.map((r) => ({
            position: r.position ?? '—',
            courses: r.courses.join(', ') || '—',
            folders: r.folders.join(', ') || '—',
          })),
          layout: 'auto',
        }] : [],
        facts: { counts: [{ kind: 'get_training_progress', label: 'positions', total: result.total }] },
      };
    }
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
