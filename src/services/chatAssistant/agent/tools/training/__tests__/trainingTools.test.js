import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getTrainingProgress from '../getTrainingProgress.tool.js';

const SELF = '64b7f0c2a1b2c3d4e5f60001';
const OTHER = '64b7f0c2a1b2c3d4e5f60002';
const viewer = (...p) => ({ id: SELF, name: 'Asha', authContext: { permissions: new Set(p) } });

function chain(result) {
  const q = { select: () => q, limit: () => q, populate: () => q, sort: () => q, lean: async () => result };
  return q;
}

const Student = (byUser) => ({ findOne: ({ user }) => chain(byUser[user] ?? null) });
const User = (rows) => ({ find: () => chain(rows) });
const COURSES = {
  totalResults: 2,
  results: [
    { module: { moduleName: 'React' }, status: 'completed', progress: { percentage: 100 } },
    { module: { moduleName: 'Node' }, status: 'in-progress', progress: { percentage: 40 } },
  ],
};

describe('get_training_progress', () => {
  it('self: reads the viewer\'s Student profile through the My Courses service', async () => {
    let args;
    const res = await getTrainingProgress.execute({ status: 'completed' }, {
      user: viewer('students.courses.read'),
      deps: {
        Student: Student({ [SELF]: { _id: 'st1' } }),
        queryStudentCourses: async (...a) => { args = a; return COURSES; },
      },
    });
    assert.deepEqual(args.slice(0, 2), ['st1', { status: 'completed' }]);
    assert.equal(res.self, true);
    assert.equal(res.total, 2);
    assert.deepEqual(res.courses.map((c) => c.percentage), [100, 40]);
    assert.ok(getTrainingProgress.measure);
  });

  it('no Student profile is said plainly, not zero courses', async () => {
    const res = await getTrainingProgress.execute({}, { user: viewer('students.courses.read'), deps: { Student: Student({}) } });
    assert.equal(res.noStudentProfile, true);
    assert.equal(getTrainingProgress.render(res), null);
  });

  it('another person needs students.read', async () => {
    const res = await getTrainingProgress.execute({ person: 'Ravi' }, {
      user: viewer('students.courses.read'),
      deps: { User: User([{ _id: OTHER, name: 'Ravi' }]), canReadOtherTraining: async () => false },
    });
    assert.match(res.error, /students\.read/);
  });

  it('ambiguous name returns matches', async () => {
    const res = await getTrainingProgress.execute({ person: 'Ra' }, {
      user: viewer('students.read'),
      deps: { User: User([{ _id: 'a', name: 'Ravi' }, { _id: 'b', name: 'Rahul' }]) },
    });
    assert.deepEqual(res.matches.map((m) => m.name), ['Ravi', 'Rahul']);
  });

  it('another person with students.read', async () => {
    const res = await getTrainingProgress.execute({ person: 'Ravi' }, {
      user: viewer('students.read'),
      deps: {
        User: User([{ _id: OTHER, name: 'Ravi' }]),
        canReadOtherTraining: async () => true,
        Student: Student({ [OTHER]: { _id: 'st2' } }),
        queryStudentCourses: async () => COURSES,
        // students.read satisfies positions.read via alias, so the roster lookup runs.
        Employee: { find: () => chain([]) },
        getPositionRoster: async () => ({ results: [] }),
      },
    });
    assert.equal(res.self, false);
    assert.equal(res.person, 'Ravi');
  });

  it('person mode is refused for a viewer who only has cohort / roster permissions', async () => {
    const res = await getTrainingProgress.execute({}, { user: viewer('evaluation.read'), deps: { Student: Student({}) } });
    assert.match(res.error, /students\.courses\.read/);
  });
});

const DAYS_AGO = (n) => new Date(Date.now() - n * 86400000).toISOString();
const EVAL_ROWS = [
  { studentId: 's1', studentName: 'Asha', courseId: 'm1', courseName: 'React Basics', positionId: 'p1', positionName: 'Java Developer',
    completionRate: 100, quizScore: 95, displayStatus: 'Completed', lastAccessedAt: DAYS_AGO(1), enrolledAt: DAYS_AGO(40), atRisk: false },
  { studentId: 's2', studentName: 'Ravi', courseId: 'm1', courseName: 'React Basics', positionId: 'p1', positionName: 'Java Developer',
    completionRate: 40, quizScore: 60, displayStatus: 'In Progress', lastAccessedAt: DAYS_AGO(20), enrolledAt: DAYS_AGO(40), atRisk: true },
  { studentId: 's3', studentName: 'Meera', courseId: 'm1', courseName: 'React Basics', positionId: null, positionName: 'Data Analyst',
    completionRate: 0, quizScore: null, displayStatus: 'Not Started', lastAccessedAt: null, enrolledAt: DAYS_AGO(3), atRisk: false },
  { studentId: 's1', studentName: 'Asha', courseId: 'm2', courseName: 'Node Advanced', positionId: 'p1', positionName: 'Java Developer',
    completionRate: 10, quizScore: 91, displayStatus: 'In Progress', lastAccessedAt: DAYS_AGO(2), enrolledAt: DAYS_AGO(10), atRisk: false },
];
const ROSTER = {
  results: [
    { id: 'p1', name: 'Java Developer', department: 'Tech', employeeCount: 3, studentCount: 2,
      assignedEmployees: [{ id: 'e1', name: 'Asha' }, { id: 'e2', name: 'Ravi' }, { id: 'e3', name: 'Kiran' }],
      assignedModules: [{ id: 'm1', name: 'React Basics' }, { id: 'm2', name: 'Node Advanced' }] },
    { id: 'p2', name: 'Data Analyst', department: 'Data', employeeCount: 1, studentCount: 1,
      assignedEmployees: [{ id: 'e4', name: 'Meera' }], assignedModules: [] },
  ],
};
const EMPLOYEES = [
  { _id: 'e1', owner: 'u1', employeeId: 'E1' }, { _id: 'e2', owner: 'u2', employeeId: 'E2' },
  { _id: 'e3', owner: 'u3', employeeId: 'E3' }, { _id: 'e4', owner: 'u4', employeeId: 'E4' },
];

function cohortDeps(extra = {}) {
  return {
    getEvaluationData: async () => ({ evaluations: EVAL_ROWS }),
    getPositionRoster: async () => ROSTER,
    Employee: { find: ({ _id }) => chain(EMPLOYEES.filter((e) => _id.$in.includes(e._id))) },
    Student: { find: ({ user }) => chain(user.$in.filter((u) => u !== 'u3').map((u) => ({ user: u }))) },
    ...extra,
  };
}

describe('get_training_progress cohort mode', () => {
  it('needs evaluation.read, like the Training Evaluation page', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', course: 'React' }, {
      user: viewer('students.read'), deps: cohortDeps(),
    });
    assert.match(res.error, /evaluation\.read/);
  });

  it('course cohort: score band, completion rate, and employees with no Student profile flagged by name', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', course: 'react basics', scoreBand: 'gte90' }, {
      user: viewer('evaluation.read', 'positions.read'), deps: cohortDeps(),
    });
    assert.equal(res.course, 'React Basics');
    assert.equal(res.total, 1);
    assert.deepEqual(res.records.map((r) => r.student), ['Asha']);
    assert.deepEqual(res.cohort, {
      assignments: 3, students: 3, completed: 1, inProgress: 1, notStarted: 1,
      completionRate: 33, avgCompletion: 47, avgQuizScore: 78, withQuizScore: 2, atRisk: 1,
    });
    assert.deepEqual(res.withoutStudentProfile, { total: 1, records: [{ name: 'Kiran', employeeId: 'E3' }] });
    assert.equal(getTrainingProgress.render(res).facts.counts[0].total, 1);
  });

  it('position cohort matches designation-fallback rows by name; lt70 excludes missing scores', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', position: 'java developer', scoreBand: 'lt70' }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.equal(res.position, 'Java Developer');
    assert.equal(res.cohort.assignments, 3);
    assert.deepEqual(res.records.map((r) => [r.student, r.quizScore]), [['Ravi', 60]]);
    assert.equal(res.withoutStudentProfile, null);
    assert.match(res.withoutStudentProfileNote, /positions\.read/);
  });

  it('not started and inactive-for-N-days filters', async () => {
    const ctx = { user: viewer('evaluation.read'), deps: cohortDeps() };
    const notStarted = await getTrainingProgress.execute({ mode: 'cohort', progress: 'not_started' }, ctx);
    assert.deepEqual(notStarted.records.map((r) => r.student), ['Meera']);
    const stale = await getTrainingProgress.execute({ mode: 'cohort', inactiveDays: 14 }, ctx);
    assert.deepEqual(stale.records.map((r) => r.student), ['Ravi']);
  });

  it('inactiveDays counts whole IST days (today included) and counts undatable rows separately', async () => {
    const row = (studentName, lastAccessedAt) => ({
      studentId: studentName, studentName, courseId: 'm1', courseName: 'React Basics', completionRate: 5,
      displayStatus: 'In Progress', lastAccessedAt, enrolledAt: null, quizScore: null,
    });
    const rows = [
      row('LateOn16th', '2026-09-16T18:00:00.000Z'), // 16 Sep 23:30 IST — only 13.5 rolling days ago
      row('EarlyOn17th', '2026-09-16T19:00:00.000Z'), // 17 Sep 00:30 IST — inside the 14-day window
      row('NeverOpened', null),
    ];
    const res = await getTrainingProgress.execute({ mode: 'cohort', inactiveDays: 14 }, {
      user: viewer('evaluation.read'),
      deps: cohortDeps({
        getEvaluationData: async () => ({ evaluations: rows }),
        now: () => Date.parse('2026-09-30T06:00:00.000Z'), // 30 Sep 11:30 IST
      }),
    });
    assert.deepEqual(res.records.map((r) => r.student), ['LateOn16th']);
    assert.equal(res.noActivityDate, 1);
    assert.match(res.noActivityDateNote, /unknown/);
  });

  it('overdue is not captured: null plus a note, never an invented count', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', course: 'React Basics', overdue: true }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.equal(res.overdue, null);
    assert.match(res.overdueNote, /no due date/);
  });

  it('unknown course is notFound', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', course: 'Rust' }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.equal(res.notFound, 'course');
    assert.equal(getTrainingProgress.render(res), null);
  });
});

describe('get_training_progress position_map mode', () => {
  it('needs a roster permission', async () => {
    const res = await getTrainingProgress.execute({ mode: 'position_map' }, {
      user: viewer('students.courses.read'), deps: cohortDeps(),
    });
    assert.match(res.error, /positions\.read/);
  });

  it('maps each position to its courses and folders', async () => {
    const TrainingModule = {
      find: () => chain([
        { _id: 'm1', categories: [{ name: 'Frontend' }] },
        { _id: 'm2', categories: [{ name: 'Backend' }, { name: 'Frontend' }] },
      ]),
    };
    const res = await getTrainingProgress.execute({ mode: 'position_map', position: 'Java' }, {
      user: viewer('positions.read'), deps: cohortDeps({ TrainingModule }),
    });
    assert.equal(res.total, 1);
    assert.deepEqual(res.records[0], {
      position: 'Java Developer', department: 'Tech', courses: ['React Basics', 'Node Advanced'], courseCount: 2,
      folders: ['Frontend', 'Backend'], employeeCount: 3, studentCount: 2,
    });
  });
});

describe('get_training_progress person last access, score, required courses', () => {
  const PERSON_COURSES = {
    totalResults: 3,
    results: [
      {
        module: { moduleName: 'React Basics' }, status: 'completed',
        progress: { percentage: 100, lastAccessedAt: '2026-09-28T10:00:00.000Z' },
        quizScores: { completedQuizzes: 2, averageScore: 91 },
        enrolledAt: '2026-08-01T00:00:00.000Z', completedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        module: { moduleName: 'Excel' }, status: 'in-progress',
        progress: { percentage: 10, lastAccessedAt: null },
        quizScores: { completedQuizzes: 0, averageScore: 0 },
        enrolledAt: '2026-09-01T00:00:00.000Z',
      },
      {
        module: { moduleName: 'Zero Quiz' }, status: 'in-progress',
        progress: { percentage: 5 },
        quizScores: { completedQuizzes: 1, averageScore: 0 },
        enrolledAt: '2026-09-02T00:00:00.000Z',
      },
    ],
  };

  function personDeps(extraDeps = {}) {
    return {
      Student: Student({ [SELF]: { _id: 'st1' } }),
      Employee: { find: () => chain([{ _id: 'e1' }]) },
      getPositionRoster: async () => ROSTER,
      queryStudentCourses: async () => PERSON_COURSES,
      ...extraDeps,
    };
  }

  it('adds lastAccessedAt and quiz score; a default 0 with no graded quiz is null', async () => {
    const res = await getTrainingProgress.execute({}, {
      user: viewer('students.courses.read', 'positions.read'),
      deps: personDeps(),
    });
    const byName = Object.fromEntries(res.courses.map((c) => [c.module, c]));
    assert.equal(byName['React Basics'].lastAccessedAt, '2026-09-28T10:00:00.000Z');
    assert.equal(byName['React Basics'].score, 91);
    assert.equal(byName.Excel.lastAccessedAt, null);
    assert.equal(byName.Excel.score, null);
    assert.notEqual(byName.Excel.lastAccessedAt, byName.Excel.enrolledAt);
    assert.equal(byName['Zero Quiz'].score, 0);
    assert.equal(res.position, 'Java Developer');
    assert.equal('mandatoryFlag' in res, false);
    assert.match(res.requiredCoursesNote, /no mandatory flag/);
    assert.deepEqual(res.requiredCourses.map((c) => c.course), ['React Basics', 'Node Advanced']);
    assert.equal(res.requiredCourses.find((c) => c.course === 'Excel'), undefined);
    assert.deepEqual(res.requiredCourses.find((c) => c.course === 'Node Advanced'), {
      course: 'Node Advanced', enrolled: false, status: null, percentage: null, score: null, lastAccessedAt: null,
    });
    assert.equal(res.allRequiredComplete, false);
    const table = getTrainingProgress.render(res).blocks[0].rows;
    assert.equal(table.find((r) => r.module === 'React Basics').score, '91%');
    assert.equal(table.find((r) => r.module === 'Excel').lastAccessedAt, '\u2014');
  });

  it('matches required courses against every assigned course, not the status-filtered page', async () => {
    const calls = [];
    const node = {
      module: { moduleName: 'Node Advanced' }, status: 'in-progress',
      progress: { percentage: 40, lastAccessedAt: '2026-09-10T00:00:00.000Z' },
      quizScores: { completedQuizzes: 1, averageScore: 70 },
      enrolledAt: '2026-08-02T00:00:00.000Z',
    };
    const res = await getTrainingProgress.execute({ status: 'completed' }, {
      user: viewer('students.courses.read', 'positions.read'),
      deps: personDeps({
        queryStudentCourses: async (_id, filter) => {
          calls.push(filter);
          if (filter.status === 'completed') {
            return { totalResults: 1, results: [PERSON_COURSES.results[0]] };
          }
          return { totalResults: 4, results: [...PERSON_COURSES.results, node] };
        },
      }),
    });
    assert.deepEqual(calls, [{ status: 'completed' }, {}]);
    assert.deepEqual(res.courses.map((c) => c.module), ['React Basics']);
    const mapped = res.requiredCourses.find((c) => c.course === 'Node Advanced');
    assert.equal(mapped.enrolled, true);
    assert.equal(mapped.status, 'in-progress');
    assert.equal(mapped.score, 70);
    assert.equal(res.allRequiredComplete, false);
  });

  it('hides the position map from a viewer the Curriculum Setup roster would hide it from', async () => {
    let calls = 0;
    const res = await getTrainingProgress.execute({}, {
      user: viewer('students.courses.read'),
      deps: personDeps({
        queryStudentCourses: async () => { calls += 1; return PERSON_COURSES; },
        getPositionRoster: async () => { throw new Error('roster must not be read'); },
      }),
    });
    assert.equal(calls, 1);
    assert.equal(res.requiredCourses, null);
    assert.match(res.requiredCoursesNote, /positions\.read/);
  });

  it('a position with no mapped courses is not "all mandatory training complete"', async () => {
    const res = await getTrainingProgress.execute({}, {
      user: viewer('students.courses.read', 'positions.read'),
      deps: personDeps({ Employee: { find: () => chain([{ _id: 'e4' }]) } }),
    });
    assert.equal(res.position, 'Data Analyst');
    assert.deepEqual(res.requiredCourses, []);
    assert.equal(res.allRequiredComplete, null);
    assert.match(res.requiredCoursesNote, /no courses mapped/);
    assert.match(res.requiredCoursesNote, /no mandatory flag/);
  });

  it('no Student profile still returns the position map and does not invent 0% progress', async () => {
    const res = await getTrainingProgress.execute({}, {
      user: viewer('students.courses.read', 'employees.read'),
      deps: personDeps({ Student: Student({}) }),
    });
    assert.equal(res.noStudentProfile, true);
    assert.equal(res.courses, undefined);
    assert.equal(res.requiredCourses.length, 2);
    assert.equal(res.requiredCourses.every((c) => c.enrolled === false), true);
    assert.equal(res.allRequiredComplete, false);
    assert.equal(getTrainingProgress.render(res), null);
  });

  it('someone not on the roster has no required courses, not an empty list', async () => {
    const res = await getTrainingProgress.execute({}, {
      user: viewer('students.read', 'positions.read'),
      deps: personDeps({ Employee: { find: () => chain([{ _id: 'e9' }]) } }),
    });
    assert.equal(res.requiredCourses, null);
    assert.match(res.requiredCoursesNote, /not on the Curriculum Setup roster/);
  });
});

describe('get_training_progress lowest completion', () => {
  it('needs evaluation.read', async () => {
    const res = await getTrainingProgress.execute({ lowestCompletion: true }, {
      user: viewer('students.courses.read'), deps: cohortDeps(),
    });
    assert.match(res.error, /evaluation\.read/);
  });

  it('ranks courses by completion rate, lowest first, and leaves out courses the evaluation page does not return', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', lowestCompletion: true, course: 'React', progress: 'completed' }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.deepEqual(res.records.map((r) => r.course), ['Node Advanced', 'React Basics']);
    assert.equal(res.records[0].completionRate, 0);
    assert.equal(res.records[0].avgCompletion, 10);
    assert.equal(res.records[0].completedCount, 0);
    assert.equal(res.records[0].studentsAssigned, 1);
    assert.equal(res.records[1].completionRate, 33);
    assert.equal(res.records[1].studentsAssigned, 3);
    assert.equal(res.records[1].completedCount, 1);
    assert.equal(res.records.some((r) => r.course === 'Secret Course'), false);
    assert.equal(res.records[0].dueDate, undefined);
    const view = getTrainingProgress.render(res);
    assert.equal(view.blocks[0].rows[0].course, 'Node Advanced');
    assert.equal(view.facts.counts[0].label, 'courses');
    assert.equal(view.facts.counts[0].total, 2);
  });

  it('can be limited to one position', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', position: 'java developer', lowestCompletion: true }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.equal(res.position, 'Java Developer');
    assert.equal(res.records[0].course, 'Node Advanced');
    assert.equal(res.records[0].completionRate, 0);
    assert.equal(res.records[1].course, 'React Basics');
    assert.equal(res.records[1].completionRate, 50);
    assert.equal(res.records[1].studentsAssigned, 2);
  });

  it('overdue stays null: courses have no due date', async () => {
    const res = await getTrainingProgress.execute({ mode: 'cohort', lowestCompletion: true, overdue: true }, {
      user: viewer('evaluation.read'), deps: cohortDeps(),
    });
    assert.equal(res.overdue, null);
    assert.match(res.overdueNote, /no due date/);
    assert.match(res.note, /no due date/);
    assert.equal(res.lowestCompletion, true);
  });
});
