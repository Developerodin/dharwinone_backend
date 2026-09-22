import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

let positions = [];
let employees = [];
let modules = [];
let studentCounts = {};

const positionFindMock = mock.fn(() => ({
  sort: () => ({
    lean: async () => positions,
  }),
}));

const employeeFindMock = mock.fn(() => ({
  select: () => ({
    lean: async () => employees,
  }),
}));

const trainingModuleFindMock = mock.fn(() => ({
  select: () => ({
    lean: async () => modules,
  }),
}));

const countStudentsByPositionMock = mock.fn(async () => studentCounts);

mock.module('../../models/position.model.js', {
  exports: {
    default: {
      find: positionFindMock,
      findOne: mock.fn(() => ({
        select: () => ({
          lean: async () => null,
        }),
      })),
    },
  },
});

mock.module('../../models/employee.model.js', {
  exports: { default: { find: employeeFindMock } },
});

mock.module('../../models/trainingModule.model.js', {
  exports: { default: { find: trainingModuleFindMock } },
});

mock.module('../positionEnrollment.service.js', {
  namedExports: { countStudentsByPosition: countStudentsByPositionMock },
});

let service;
before(async () => {
  service = await import('../position.service.js');
});

test('catalog position reports employeeCount and studentCount independently', async () => {
  positions = [{ _id: 'p1', name: 'Analyst', department: 'Ops' }];
  employees = Array.from({ length: 8 }, (_, i) => ({
    _id: `e${i}`,
    fullName: `Emp ${i}`,
    email: `e${i}@ex.com`,
    position: 'p1',
    designation: 'Analyst',
  }));
  modules = [];
  studentCounts = { p1: 3 };
  countStudentsByPositionMock.mock.resetCalls();

  const roster = await service.getPositionRoster();
  const row = roster.find((r) => r.id === 'p1');

  assert.ok(row);
  assert.equal(row.employeeCount, 8);
  assert.equal(row.studentCount, 3);
  assert.equal(countStudentsByPositionMock.mock.callCount(), 1);
  assert.deepEqual(countStudentsByPositionMock.mock.calls[0].arguments[0], ['p1']);
});

test('unlinked roster row reports studentCount 0', async () => {
  positions = [{ _id: 'p1', name: 'Analyst', department: 'Ops' }];
  employees = [
    {
      _id: 'e9',
      fullName: 'Unlinked Emp',
      email: 'u@ex.com',
      position: null,
      designation: 'Ghost Title',
      referralJobTitle: null,
    },
  ];
  modules = [];
  studentCounts = { p1: 0 };
  countStudentsByPositionMock.mock.resetCalls();

  const roster = await service.getPositionRoster();
  const unlinked = roster.find((r) => r.unlinked === true);

  assert.ok(unlinked);
  assert.equal(unlinked.studentCount, 0);
  assert.equal(unlinked.employeeCount, 1);
});
