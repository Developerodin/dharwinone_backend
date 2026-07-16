import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvaluation,
  deriveCourseDisplayStatus,
  computeAtRisk,
  computeEnrollmentStatusBreakdown,
  isEmployeeResigned,
  resolveStudentPositionMeta,
  AT_RISK_STALE_DAYS,
} from '../evaluation.service.js';

const find = (rows, sid, mid) => rows.find((r) => r.studentId === sid && r.courseId === mid);

test('isEmployeeResigned: resignDate on or before today', () => {
  const today = new Date('2026-07-16T12:00:00Z');
  today.setHours(0, 0, 0, 0);
  assert.equal(isEmployeeResigned({ resignDate: '2026-07-15' }, today), true);
  assert.equal(isEmployeeResigned({ resignDate: '2026-07-16' }, today), true);
  assert.equal(isEmployeeResigned({ resignDate: '2026-07-17' }, today), false);
  assert.equal(isEmployeeResigned({ referralPipelineStatus: 'resigned' }, today), true);
  assert.equal(isEmployeeResigned(null, today), false);
});

test('resolveStudentPositionMeta prefers student.position then employee.position then designation', () => {
  assert.deepEqual(
    resolveStudentPositionMeta(
      { position: { _id: 'p1', name: 'Data Analyst Intern' } },
      { position: { _id: 'p2', name: 'Other' }, designation: 'Ignored' }
    ),
    { positionId: 'p1', positionName: 'Data Analyst Intern' }
  );

  assert.deepEqual(
    resolveStudentPositionMeta(
      { position: null },
      { position: { _id: 'p2', name: 'IT Business Analyst' } }
    ),
    { positionId: 'p2', positionName: 'IT Business Analyst' }
  );

  assert.deepEqual(
    resolveStudentPositionMeta({ position: null }, { designation: 'Data Analyst Intern' }),
    { positionId: null, positionName: 'Data Analyst Intern' }
  );
});

test('buildEvaluation uses positionName from studentMetaById (employee fallback path)', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1'] }],
    progressList: [],
    quizAttempts: [],
    studentMetaById: new Map([
      ['s1', { name: 'Abhilash', positionId: 'p1', positionName: 'Data Analyst Intern' }],
    ]),
  });

  const row = find(evaluations, 's1', 'm1');
  assert.equal(row.positionName, 'Data Analyst Intern');
  assert.equal(row.positionId, 'p1');
});

test('includes assigned-but-not-started pairs as synthesized 0% rows', () => {
  const { evaluations, summary } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1', 's2'] }],
    progressList: [
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm1', moduleName: 'Course 1' },
        progress: { percentage: 50 },
        completedAt: null,
        status: 'in-progress',
      },
    ],
    quizAttempts: [],
    studentMetaById: new Map([['s2', { name: 'Bob' }]]),
  });

  assert.equal(evaluations.length, 2);

  const started = find(evaluations, 's1', 'm1');
  assert.equal(started.completionRate, 50);
  assert.equal(started.displayStatus, 'In Progress');

  const notStarted = find(evaluations, 's2', 'm1');
  assert.ok(notStarted);
  assert.equal(notStarted.completionRate, 0);
  assert.equal(notStarted.displayStatus, 'Not Started');
  assert.equal(summary.totalStudentsEnrolled, 2);
});

test('quizScore is average; quizScoreBest is highest graded attempt', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1'] }],
    progressList: [
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm1', moduleName: 'Course 1' },
        progress: { percentage: 100 },
        completedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
      },
    ],
    quizAttempts: [
      { student: 's1', module: 'm1', score: { percentage: 60 } },
      { student: 's1', module: 'm1', score: { percentage: 80 } },
    ],
    studentMetaById: new Map(),
  });

  const row = find(evaluations, 's1', 'm1');
  assert.equal(row.quizScore, 70);
  assert.equal(row.quizScoreBest, 80);
  assert.equal(row.displayStatus, 'Completed');
});

test('skips stale roster ids with no resolvable name and no progress', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1', 's_deleted'] }],
    progressList: [
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm1', moduleName: 'Course 1' },
        progress: { percentage: 10 },
        completedAt: null,
        status: 'in-progress',
      },
    ],
    quizAttempts: [],
    studentMetaById: new Map(),
  });

  assert.equal(evaluations.length, 1);
  assert.ok(!find(evaluations, 's_deleted', 'm1'));
});

test('excludes inactive students when activeStudentIds is provided', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1', 's2'] }],
    progressList: [],
    quizAttempts: [],
    studentMetaById: new Map([
      ['s1', { name: 'Alice' }],
      ['s2', { name: 'Bob' }],
    ]),
    activeStudentIds: new Set(['s1']),
  });

  assert.equal(evaluations.length, 1);
  assert.ok(find(evaluations, 's1', 'm1'));
  assert.ok(!find(evaluations, 's2', 'm1'));
});

test('essayScore averages graded essay attempts', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1'] }],
    progressList: [
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm1', moduleName: 'Course 1' },
        progress: { percentage: 40 },
        status: 'in-progress',
      },
    ],
    essayAttempts: [
      { student: 's1', module: 'm1', score: { percentage: 70 } },
      { student: 's1', module: 'm1', score: { percentage: 90 } },
    ],
    studentMetaById: new Map(),
  });

  const row = find(evaluations, 's1', 'm1');
  assert.equal(row.essayScore, 80);
});

test('computeEnrollmentStatusBreakdown counts roster pairs without progress as not started', () => {
  const breakdown = computeEnrollmentStatusBreakdown({
    modules: [{ _id: 'm1', moduleName: 'Course 1', students: ['s1', 's2'] }],
    progressList: [
      {
        student: 's1',
        module: 'm1',
        progress: { percentage: 50 },
        status: 'in-progress',
      },
    ],
    activeStudentIds: new Set(['s1', 's2']),
  });
  assert.equal(breakdown.notStarted, 1);
  assert.equal(breakdown.inProgress, 1);
  assert.equal(breakdown.completed, 0);
});

test('excludes progress-only pairs when student is not on module roster', () => {
  const { evaluations } = buildEvaluation({
    modules: [{ _id: 'm1', moduleName: 'Assigned', students: ['s1'] }],
    progressList: [
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm1', moduleName: 'Assigned' },
        progress: { percentage: 100 },
        completedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
      },
      {
        student: { _id: 's1', user: { name: 'Alice' } },
        module: { _id: 'm_orphan', moduleName: 'Removed assignment' },
        progress: { percentage: 100 },
        completedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
      },
    ],
    quizAttempts: [],
    studentMetaById: new Map([['s1', { name: 'Alice' }]]),
  });

  assert.equal(evaluations.length, 1);
  assert.ok(find(evaluations, 's1', 'm1'));
  assert.ok(!find(evaluations, 's1', 'm_orphan'));
});

test('computeEnrollmentStatusBreakdown ignores progress-only pairs', () => {
  const breakdown = computeEnrollmentStatusBreakdown({
    modules: [{ _id: 'm1', moduleName: 'Assigned', students: ['s1'] }],
    progressList: [
      {
        student: 's1',
        module: 'm1',
        progress: { percentage: 100 },
        completedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
      },
      {
        student: 's1',
        module: 'm_orphan',
        progress: { percentage: 100 },
        completedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'completed',
      },
    ],
    activeStudentIds: new Set(['s1']),
  });
  assert.equal(breakdown.completed, 1);
  assert.equal(breakdown.inProgress, 0);
  assert.equal(breakdown.notStarted, 0);
});

test('deriveCourseDisplayStatus: 100% without completedAt is In Progress unless certificate issued', () => {
  assert.equal(
    deriveCourseDisplayStatus({ completionRate: 100, completedAt: null, status: 'in-progress' }),
    'In Progress'
  );
  assert.equal(
    deriveCourseDisplayStatus({ completionRate: 100, completedAt: null, certificateIssued: true }),
    'Completed'
  );
});

test('computeAtRisk flags stale in-progress enrollments', () => {
  const stale = new Date(Date.now() - (AT_RISK_STALE_DAYS + 2) * 86400000);
  const row = {
    displayStatus: 'In Progress',
    completionRate: 30,
    lastAccessedAt: stale.toISOString(),
  };
  const risk = computeAtRisk(row);
  assert.equal(risk.atRisk, true);
  assert.equal(risk.atRiskReason, 'stale');
});
