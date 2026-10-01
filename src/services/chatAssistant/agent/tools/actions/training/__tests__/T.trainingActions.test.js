import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import assignTraining, { ASSIGN_ACCESS } from '../assignTraining.tool.js';
import sendCourseReminder, { REMINDER_ACCESS } from '../sendCourseReminder.tool.js';
import { checkPrepared } from '../../../../sageActions.js';
import { checkAccessRule } from '../../../../../toolAccess.js';

// Every model here is an in-memory fake passed through ctx.deps: nothing reaches Mongo.
const VIEWER_ID = '64b7f0c2a1b2c3d4e5f60001';
const viewer = (...p) => ({ id: VIEWER_ID, name: 'Asha', authContext: { permissions: new Set(p) } });

const USERS = [
  { _id: 'u1', name: 'Priya Shah', email: 'priya.shah@acme.test', status: 'active' },
  { _id: 'u2', name: 'Ravi Kumar', email: 'ravi@acme.test', status: 'active' },
  { _id: 'u3', name: 'Nita Rao', email: 'nita@acme.test', status: 'active' },
  { _id: 'u4', name: 'Priya Menon', email: 'priya.m@acme.test', status: 'active' },
  { _id: 'u5', name: 'Root Admin', email: 'root@acme.test', status: 'active', platformSuperUser: true },
  { _id: 'u6', name: 'Gone Person', email: 'gone@acme.test', status: 'deleted' },
  { _id: 'u7', name: 'Meera Iyer', email: 'meera@acme.test', status: 'active' },
  { _id: 'u8', name: 'Kiran Das', email: 'kiran@acme.test', status: 'active' },
];
// u3 (Nita) has no Student profile.
const STUDENT_OF = { u1: 's1', u2: 's2', u4: 's4', u5: 's5', u6: 's6', u7: 's7', u8: 's8' };
// s8 (Kiran) has an inactive Student profile: the course pages don't list it.
const INACTIVE_STUDENTS = new Set(['s8']);
const MODULES = [
  { _id: 'm1', moduleName: 'Java Basics', status: 'published', students: [] },
  { _id: 'm2', moduleName: 'Java Advanced', status: 'published', students: [] },
  { _id: 'm3', moduleName: 'Secret Draft', status: 'draft', students: [] },
];

const q = (result) => {
  const c = { select: () => c, limit: () => c, lean: async () => structuredClone(result) };
  return c;
};
const rx = (cond) => new RegExp(cond.$regex, cond.$options);

function fakeUser() {
  return {
    find: mock.fn((f) => q(USERS.filter((u) => {
      if (f.status?.$ne && u.status === f.status.$ne) return false;
      if (f.platformSuperUser?.$ne === true && u.platformSuperUser) return false;
      if (f.name) return rx(f.name).test(u.name);
      if (f.email) return rx(f.email).test(u.email);
      return true;
    }))),
  };
}
function fakeStudent() {
  return {
    find: mock.fn(({ user }) => q(user.$in.filter((id) => STUDENT_OF[id]).map((id) => ({ _id: STUDENT_OF[id], user: id, status: INACTIVE_STUDENTS.has(STUDENT_OF[id]) ? 'inactive' : 'active' })))),
  };
}
function fakeModules(rosters = {}) {
  const mods = MODULES.map((m) => ({ ...m, students: rosters[m._id] ?? [] }));
  return {
    find: mock.fn((f) => q(mods.filter((m) => rx(f.moduleName).test(m.moduleName) && (!f.status || m.status === f.status)))),
    findById: mock.fn((id) => q(mods.find((m) => m._id === id) ?? null)),
  };
}
function fakeSageAction(rows = []) {
  return {
    rows,
    find: mock.fn((f) => q(rows.filter((r) =>
      r.tool === f.tool &&
      r.payload?.moduleId === f['payload.moduleId'] &&
      f.status.$in.includes(r.status) &&
      r.confirmedAt >= f.confirmedAt.$gte &&
      (!f.key || r.key !== f.key.$ne)))),
  };
}

const NOW = new Date('2026-09-30T12:00:00Z').getTime();
const HOURS = (h) => new Date(NOW - h * 3600 * 1000);

function deps(overrides = {}) {
  return {
    User: fakeUser(),
    Student: fakeStudent(),
    TrainingModule: fakeModules(),
    SageAction: fakeSageAction(),
    now: () => NOW,
    ...overrides,
  };
}

/** statusByStudent: { s1: 'enrolled' | 'in-progress' | 'completed' | 'dropped' }; absent = not enrolled. */
const eligibility = (statusByStudent, moduleName = 'Java Basics') =>
  mock.fn(async (moduleId, ids) => {
    const out = { module: { id: moduleId, moduleName }, remind: [], completed: [], dropped: [], notEnrolled: [] };
    for (const id of ids) {
      const s = statusByStudent[id];
      if (!s) out.notEnrolled.push(id);
      else if (s === 'completed') out.completed.push(id);
      else if (s === 'dropped') out.dropped.push(id);
      else out.remind.push(id);
    }
    return out;
  });

const text = (prepared) => [prepared.summary.title, ...prepared.summary.lines].join('\n');

describe('assign_training', () => {
  it('drafts adding named people, with recipients, channel and the exact notice text', async () => {
    const d = deps();
    const prepared = await assignTraining.prepare({ people: ['Priya Shah', 'ravi@acme.test'], module: 'java basics' }, { user: viewer('modules.manage'), deps: d });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(checkPrepared(prepared, assignTraining).ok, true);
    assert.deepEqual(prepared.payload, { moduleId: 'm1', studentIds: ['s1', 's2'] });
    assert.deepEqual(prepared.summary.targets, [{ id: 's1', name: 'Priya Shah' }, { id: 's2', name: 'Ravi Kumar' }]);
    const t = text(prepared);
    assert.match(t, /Add to "Java Basics": Priya Shah, Ravi Kumar/);
    assert.match(t, /in-app notification and email/);
    assert.match(t, /You have been assigned to "Java Basics"\./);
    assert.match(t, /Nobody already on the course is removed/);
  });

  it('skips people already on the course and people with no training profile, and names them', async () => {
    const d = deps({ TrainingModule: fakeModules({ m1: ['s2'] }) });
    const prepared = await assignTraining.prepare({ people: ['Priya Shah', 'Ravi Kumar', 'Nita Rao'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: d });
    assert.equal(prepared.ok, true, prepared.error);
    assert.deepEqual(prepared.payload.studentIds, ['s1']);
    assert.match(text(prepared), /already on the course, not notified again: Ravi Kumar/);
    assert.match(text(prepared), /no training profile \(none will be created\): Nita Rao/);
  });

  it('refuses invisible people (deleted, platform super) by the name asked for only', async () => {
    const d = deps();
    const prepared = await assignTraining.prepare({ people: ['Root Admin', 'Gone Person'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: d });
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /No one found for "Root Admin", "Gone Person"/);
    assert.doesNotMatch(prepared.error, /@/);
    assert.equal(d.Student.find.mock.callCount(), 0);
  });

  it('refuses an ambiguous name instead of guessing', async () => {
    const prepared = await assignTraining.prepare({ people: ['Priya'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: deps() });
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /Several people match "Priya": Priya Shah .*Priya Menon/);
  });

  it('caps the people list at 50', () => {
    const people = Array.from({ length: 51 }, (_, i) => `Person ${i}`);
    assert.ok(assignTraining.input.validate({ people, module: 'Java Basics' }).error);
    assert.equal(assignTraining.input.validate({ people: people.slice(0, 50), module: 'Java Basics' }).error, undefined);
    assert.equal(assignTraining.maxTargets, 50);
  });

  it('missing data: an unknown course, or nobody left to add, is refused', async () => {
    const noCourse = await assignTraining.prepare({ people: ['Priya Shah'], module: 'Rust' }, { user: viewer('modules.manage'), deps: deps() });
    assert.deepEqual(noCourse, { ok: false, error: 'No course matches "Rust".' });
    const noProfile = await assignTraining.prepare({ people: ['Nita Rao'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: deps() });
    assert.equal(noProfile.ok, false);
    assert.match(noProfile.error, /Nobody to add .*no training profile/);
  });

  it('skips an inactive training profile instead of assigning or notifying it', async () => {
    const res = await assignTraining.prepare({ people: ['Priya Shah', 'Kiran Das'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: deps() });
    assert.equal(res.ok, true);
    assert.deepEqual(res.summary.targets.map((t) => t.name), ['Priya Shah']);
    assert.ok(res.summary.lines.includes('Skipped — training profile not active: Kiran Das.'));
  });

  it('looks up the exact course name before a partial match', async () => {
    const d = deps();
    await assignTraining.prepare({ people: ['Priya Shah'], module: 'Java Basics' }, { user: viewer('modules.manage'), deps: d });
    assert.equal(d.TrainingModule.find.mock.calls[0].arguments[0].moduleName.$regex, '^Java Basics$');
  });

  it('access mirrors PATCH /training/modules/:id: modules.manage only', async () => {
    assert.deepEqual(ASSIGN_ACCESS, { allOf: ['modules.manage'] });
    assert.equal((await checkAccessRule(assignTraining.access, viewer('students.manage', 'modules.read'))).ok, false);
    assert.equal((await checkAccessRule(assignTraining.access, viewer('modules.manage'))).ok, true);
  });

  it('commit calls enrollStudentsInModule with exactly the payload ids', async () => {
    const enroll = mock.fn(async (_m, ids) => ({ added: ids, alreadyEnrolled: [], notFound: [] }));
    const user = viewer('modules.manage');
    const res = await assignTraining.commit({ key: 'k1', payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } }, { user, deps: { enrollStudentsInModule: enroll } });
    assert.equal(enroll.mock.callCount(), 1);
    assert.deepEqual(enroll.mock.calls[0].arguments, ['m1', ['s1', 's2'], user]);
    assert.equal(res.ok, true);
    assert.deepEqual(res.details.addedStudentIds, ['s1', 's2']);
  });

  it('commit is safe on replay: the second run adds and notifies nobody', async () => {
    const roster = new Set();
    const notified = [];
    const enroll = async (_m, ids) => {
      const added = ids.filter((id) => !roster.has(id));
      added.forEach((id) => { roster.add(id); notified.push(id); });
      return { added, alreadyEnrolled: ids.filter((id) => !added.includes(id)), notFound: [] };
    };
    const draft = { key: 'k1', payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } };
    const ctx = { user: viewer('modules.manage'), deps: { enrollStudentsInModule: enroll } };
    await assignTraining.commit(draft, ctx);
    const again = await assignTraining.commit(draft, ctx);
    assert.deepEqual(notified, ['s1', 's2']);
    assert.deepEqual(again.details.addedStudentIds, []);
    assert.match(again.message, /Assigned the course to 0 people\. 2 people were already on it/);
  });
});

describe('send_course_reminder', () => {
  const ENROLLED = { s1: 'enrolled', s2: 'in-progress' };

  it('drafts a reminder to enrolled, unfinished people with the exact message and no "overdue"', async () => {
    const d = deps({ courseReminderEligibility: eligibility(ENROLLED) });
    const prepared = await sendCourseReminder.prepare({ people: ['Priya Shah', 'Ravi Kumar'], module: 'Java Basics' }, { user: viewer('students.manage'), deps: d });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(checkPrepared(prepared, sendCourseReminder).ok, true);
    assert.deepEqual(prepared.payload, { moduleId: 'm1', studentIds: ['s1', 's2'] });
    const t = text(prepared);
    assert.match(t, /Recipients: Priya Shah, Ravi Kumar\./);
    assert.match(t, /in-app notification and email/);
    assert.match(t, /This is a reminder to continue your course "Java Basics"\./);
    assert.doesNotMatch(t, /overdue/i);
    assert.deepEqual(d.courseReminderEligibility.mock.calls[0].arguments, ['m1', ['s1', 's2']]);
  });

  it('skips completed, dropped, not enrolled, no profile and reminded-in-24h people, naming each', async () => {
    const sage = fakeSageAction([
      { key: 'old', tool: 'send_course_reminder', status: 'done', confirmedAt: HOURS(3), payload: { moduleId: 'm1', studentIds: ['s7'] }, result: { details: { remindedStudentIds: ['s7'] } } },
      { key: 'stale', tool: 'send_course_reminder', status: 'done', confirmedAt: HOURS(30), payload: { moduleId: 'm1', studentIds: ['s1'] }, result: { details: { remindedStudentIds: ['s1'] } } },
    ]);
    const d = deps({
      SageAction: sage,
      courseReminderEligibility: eligibility({ s1: 'enrolled', s2: 'completed', s4: 'dropped', s7: 'in-progress' }),
    });
    const prepared = await sendCourseReminder.prepare(
      { people: ['Priya Shah', 'Ravi Kumar', 'Priya Menon', 'Nita Rao', 'Meera Iyer'], module: 'Java Basics' },
      { user: viewer('students.manage'), deps: d }
    );
    assert.equal(prepared.ok, true, prepared.error);
    assert.deepEqual(prepared.payload.studentIds, ['s1']);
    const t = text(prepared);
    assert.match(t, /completed the course: Ravi Kumar/);
    assert.match(t, /dropped the course: Priya Menon/);
    assert.match(t, /no training profile: Nita Rao/);
    assert.match(t, /already reminded about this course in the last 24 hours: Meera Iyer/);
  });

  it('row scope: a draft course is invisible without modules.manage and refused by name only', async () => {
    const hidden = await sendCourseReminder.prepare({ people: ['Priya Shah'], module: 'Secret Draft' }, { user: viewer('students.manage'), deps: deps({ courseReminderEligibility: eligibility(ENROLLED) }) });
    assert.deepEqual(hidden, { ok: false, error: 'No course matches "Secret Draft".' });
    const manager = await sendCourseReminder.prepare({ people: ['Priya Shah'], module: 'Secret Draft' }, { user: viewer('modules.manage'), deps: deps({ courseReminderEligibility: eligibility(ENROLLED, 'Secret Draft') }) });
    assert.equal(manager.ok, true, manager.error);
  });

  it('caps the people list at 50', () => {
    const people = Array.from({ length: 51 }, (_, i) => `Person ${i}`);
    assert.ok(sendCourseReminder.input.validate({ people, module: 'Java Basics' }).error);
    assert.equal(sendCourseReminder.maxTargets, 50);
  });

  it('missing data: nobody enrolled and unfinished means no draft', async () => {
    const prepared = await sendCourseReminder.prepare({ people: ['Priya Shah'], module: 'Java Basics' }, { user: viewer('students.manage'), deps: deps({ courseReminderEligibility: eligibility({ s1: 'completed' }) }) });
    assert.equal(prepared.ok, false);
    assert.match(prepared.error, /Nobody to remind about "Java Basics"\. Skipped — completed the course: Priya Shah/);
  });

  it('access is modules.manage OR students.manage', async () => {
    assert.deepEqual(REMINDER_ACCESS, { anyOf: ['modules.manage', 'students.manage'] });
    assert.equal((await checkAccessRule(sendCourseReminder.access, viewer('students.read', 'modules.read'))).ok, false);
    assert.equal((await checkAccessRule(sendCourseReminder.access, viewer('students.manage'))).ok, true);
    assert.equal((await checkAccessRule(sendCourseReminder.access, viewer('modules.manage'))).ok, true);
  });

  it('re-prepare on confirm does not count the draft\'s own executing row', async () => {
    const sage = fakeSageAction([
      { key: 'mine', tool: 'send_course_reminder', status: 'executing', confirmedAt: HOURS(0), payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } },
    ]);
    const prepared = await sendCourseReminder.prepare({ people: ['Priya Shah', 'Ravi Kumar'], module: 'Java Basics' }, { user: viewer('students.manage'), deps: deps({ SageAction: sage, courseReminderEligibility: eligibility(ENROLLED) }) });
    assert.deepEqual(prepared.payload.studentIds, ['s1', 's2']);
  });

  it('commit calls sendCourseReminder with exactly the payload ids', async () => {
    const send = mock.fn(async (_m, ids) => ({ reminded: ids, completed: [], dropped: [], notEnrolled: [] }));
    const user = viewer('students.manage');
    const res = await sendCourseReminder.commit({ key: 'k1', payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } }, { user, deps: { SageAction: fakeSageAction(), sendCourseReminder: send, now: () => NOW } });
    assert.deepEqual(send.mock.calls[0].arguments, ['m1', ['s1', 's2'], user]);
    assert.deepEqual(res.details.remindedStudentIds, ['s1', 's2']);
    assert.equal(res.ok, true);
  });

  it('commit is safe on replay: a second run within 24 h sends nothing', async () => {
    const sage = fakeSageAction();
    const send = mock.fn(async (_m, ids) => ({ reminded: ids, completed: [], dropped: [], notEnrolled: [] }));
    const ctx = { user: viewer('students.manage'), deps: { SageAction: sage, sendCourseReminder: send, now: () => NOW } };
    const draft = { key: 'k1', payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } };
    const first = await sendCourseReminder.commit(draft, ctx);
    sage.rows.push({ key: 'k1', tool: 'send_course_reminder', status: 'done', confirmedAt: HOURS(0), payload: draft.payload, result: { details: first.details } });

    const replay = await sendCourseReminder.commit({ ...draft, key: 'k2' }, ctx);
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(replay.details.remindedStudentIds, []);
    assert.match(replay.message, /Nothing sent/);
  });

  it('commit skips people another confirm is reminding right now, but never its own row', async () => {
    const sage = fakeSageAction([
      { key: 'other', tool: 'send_course_reminder', status: 'executing', confirmedAt: HOURS(0), payload: { moduleId: 'm1', studentIds: ['s2'] } },
      { key: 'k1', tool: 'send_course_reminder', status: 'executing', confirmedAt: HOURS(0), payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } },
    ]);
    const send = mock.fn(async (_m, ids) => ({ reminded: ids, completed: [], dropped: [], notEnrolled: [] }));
    await sendCourseReminder.commit({ key: 'k1', payload: { moduleId: 'm1', studentIds: ['s1', 's2'] } }, { user: viewer('students.manage'), deps: { SageAction: sage, sendCourseReminder: send, now: () => NOW } });
    assert.deepEqual(send.mock.calls[0].arguments[1], ['s1']);
  });
});
