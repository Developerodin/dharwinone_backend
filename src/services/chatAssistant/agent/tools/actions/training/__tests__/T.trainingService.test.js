import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// In-memory models + notify: the service's writes land here, never in Mongo, and nothing is sent.
let modules;
let progress;
const STUDENTS = [
  { _id: 's1', user: 'u1' },
  { _id: 's2', user: 'u2' },
  { _id: 's3', user: 'u3' },
];
const notify = mock.fn(async () => null);
const plainTextEmailBody = (message, link) => `${message}\n\nhttps://app.test${link}`;

const q = (fn) => {
  const c = { select: () => c, lean: async () => structuredClone(fn()) };
  return c;
};

const FakeTrainingModule = {
  findById: mock.fn((id) => q(() => modules.get(String(id)) ?? null)),
  updateOne: mock.fn(async ({ _id }, update) => {
    const m = modules.get(String(_id));
    const id = String(update.$addToSet.students);
    if (!m || m.students.includes(id)) return { modifiedCount: 0 };
    m.students.push(id);
    return { modifiedCount: 1 };
  }),
};
const FakeStudent = { find: mock.fn(({ _id }) => q(() => STUDENTS.filter((s) => _id.$in.includes(s._id)))) };
const FakeProgress = {
  find: mock.fn(({ module, student }) => q(() => progress.filter((p) => p.module === module && student.$in.includes(p.student)))),
};

let svc;
before(async () => {
  mock.module('../../../../../../../models/trainingModule.model.js', { defaultExport: FakeTrainingModule });
  mock.module('../../../../../../../models/student.model.js', { defaultExport: FakeStudent });
  mock.module('../../../../../../../models/studentCourseProgress.model.js', { defaultExport: FakeProgress });
  mock.module('../../../../../../notification.service.js', { namedExports: { notify, plainTextEmailBody } });
  svc = await import('../../../../../../trainingModule.service.js');
});

beforeEach(() => {
  modules = new Map([['m1', { _id: 'm1', moduleName: 'Java Basics', status: 'published', students: ['s2'] }]]);
  progress = [];
  notify.mock.resetCalls();
  FakeTrainingModule.updateOne.mock.resetCalls();
});

describe('enrollStudentsInModule', () => {
  it('adds only new students with $addToSet and sends the "Course assigned" notice to them alone', async () => {
    const res = await svc.enrollStudentsInModule('m1', ['s1', 's2', 'missing'], { id: 'admin' });
    assert.deepEqual(res, { added: ['s1'], alreadyEnrolled: ['s2'], notFound: ['missing'] });
    assert.deepEqual(modules.get('m1').students, ['s2', 's1']);
    for (const call of FakeTrainingModule.updateOne.mock.calls) {
      assert.deepEqual(Object.keys(call.arguments[1]), ['$addToSet']);
    }
    assert.equal(notify.mock.callCount(), 1);
    const [userId, payload] = notify.mock.calls[0].arguments;
    assert.equal(userId, 'u1');
    assert.deepEqual(payload, {
      type: 'course',
      title: 'Course assigned',
      message: 'You have been assigned to "Java Basics".',
      link: '/training/curriculum/modules',
      email: {
        subject: 'Course assigned: Java Basics',
        text: 'You have been assigned to "Java Basics".\n\nhttps://app.test/training/curriculum/modules',
      },
    });
  });

  it('is safe on replay: the second call adds nobody and notifies nobody', async () => {
    await svc.enrollStudentsInModule('m1', ['s1'], {});
    const again = await svc.enrollStudentsInModule('m1', ['s1'], {});
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.alreadyEnrolled, ['s1']);
    assert.equal(notify.mock.callCount(), 1);
  });

  it('a missing module is a 404, with nothing written', async () => {
    await assert.rejects(svc.enrollStudentsInModule('nope', ['s1'], {}), /Training module not found/);
    assert.equal(FakeTrainingModule.updateOne.mock.callCount(), 0);
  });
});

describe('sendCourseReminder', () => {
  it('reminds only enrolled, unfinished students; completed, dropped and not enrolled are returned unsent', async () => {
    modules.get('m1').students = ['s1', 's2', 's3'];
    progress = [
      { module: 'm1', student: 's2', status: 'completed' },
      { module: 'm1', student: 's3', status: 'dropped' },
    ];
    const res = await svc.sendCourseReminder('m1', ['s1', 's2', 's3', 's9'], {});
    assert.deepEqual(res, { reminded: ['s1'], completed: ['s2'], dropped: ['s3'], notEnrolled: ['s9'] });
    assert.equal(notify.mock.callCount(), 1);
    const [userId, payload] = notify.mock.calls[0].arguments;
    assert.equal(userId, 'u1');
    assert.equal(payload.type, 'course');
    assert.equal(payload.title, 'Course reminder');
    assert.equal(payload.message, 'This is a reminder to continue your course "Java Basics".');
    assert.equal(payload.email.subject, 'Reminder: Java Basics');
    assert.doesNotMatch(JSON.stringify(payload), /overdue/i);
  });

  it('does not email a student whose user id is outside visibleUserIds', async () => {
    modules.get('m1').students = ['s1', 's2'];
    const res = await svc.sendCourseReminder('m1', ['s1', 's2'], {}, { visibleUserIds: new Set(['u1']) });
    assert.deepEqual(res.reminded, ['s1']);
    assert.deepEqual(res.outOfScope, ['s2']);
    assert.equal(notify.mock.callCount(), 1);
    assert.equal(notify.mock.calls[0].arguments[0], 'u1');
  });

  it('a student with no progress row yet counts as enrolled', async () => {
    const res = await svc.courseReminderEligibility('m1', ['s2']);
    assert.deepEqual(res.remind, ['s2']);
  });
});
