import StudentModel from '../../../../../models/student.model.js';
import UserModel from '../../../../../models/user.model.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import TrainingModuleModel from '../../../../../models/trainingModule.model.js';
import { queryStudentCourses as realQueryStudentCourses } from '../../../../studentCourseQuery.service.js';
import evaluationService from '../../../../evaluation.service.js';
import { getPositionRoster as realGetPositionRoster } from '../../../../position.service.js';
import { canReadOtherTraining, checkAccessRule } from '../../../toolAccess.js';

// student.route.js GET /me + /:studentId/courses (My Courses).
export const PERSON_ACCESS = Object.freeze({ anyOf: ['students.courses.read', 'students.read', 'students.manage'] });
// evaluation.route.js GET / (Training → Evaluation page).
export const COHORT_ACCESS = Object.freeze({ anyOf: ['evaluation.read'] });
// position.route.js canReadPositionRoster (Curriculum Setup roster: employee names per position).
export const ROSTER_ACCESS = Object.freeze({
  anyOf: ['employees.read', 'candidates.read', 'positions.manage', 'positions.read'],
});
export const TRAINING_ACCESS = Object.freeze({
  anyOf: [...new Set([...PERSON_ACCESS.anyOf, ...COHORT_ACCESS.anyOf, ...ROSTER_ACCESS.anyOf])],
});

export const MAX_LIST_LIMIT = 50;
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function trainingScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('training tools need an authenticated user with an id');
  return ctx.user;
}

export function trainingDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    Student: deps.Student ?? StudentModel,
    User: deps.User ?? UserModel,
    Employee: deps.Employee ?? EmployeeModel,
    TrainingModule: deps.TrainingModule ?? TrainingModuleModel,
    queryStudentCourses: deps.queryStudentCourses ?? realQueryStudentCourses,
    getEvaluationData: deps.getEvaluationData ?? evaluationService.getEvaluationData,
    getPositionRoster: deps.getPositionRoster ?? realGetPositionRoster,
    canReadOtherTraining: deps.canReadOtherTraining ?? canReadOtherTraining,
    now: deps.now ?? Date.now,
  };
}

export async function allowed(rule, user) {
  return (await checkAccessRule(rule, user)).ok;
}

/** Exact (case-insensitive) name wins; else a unique substring match; else ambiguous / none. */
export function pickByName(items, query, nameOf = (x) => x.name) {
  const q = String(query).trim().toLowerCase();
  const exact = items.filter((x) => String(nameOf(x) ?? '').toLowerCase() === q);
  if (exact.length) return { kind: 'found', items: exact };
  const partial = items.filter((x) => String(nameOf(x) ?? '').toLowerCase().includes(q));
  if (partial.length === 1) return { kind: 'found', items: partial };
  if (partial.length > 1) return { kind: 'ambiguous', items: partial };
  return { kind: 'notFound', items: [] };
}
