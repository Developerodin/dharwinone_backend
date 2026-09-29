import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getTrainingProgress from '../getTrainingProgress.tool.js';

const SELF = '64b7f0c2a1b2c3d4e5f60001';
const OTHER = '64b7f0c2a1b2c3d4e5f60002';
const viewer = (...p) => ({ id: SELF, name: 'Asha', authContext: { permissions: new Set(p) } });

function chain(result) {
  const q = { select: () => q, limit: () => q, lean: async () => result };
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
      },
    });
    assert.equal(res.self, false);
    assert.equal(res.person, 'Ravi');
  });
});
