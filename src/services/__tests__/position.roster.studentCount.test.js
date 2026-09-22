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
  const row = roster.results.find((r) => r.id === 'p1');

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
  const unlinked = roster.results.find((r) => r.unlinked === true);

  assert.ok(unlinked);
  assert.equal(unlinked.studentCount, 0);
  assert.equal(unlinked.employeeCount, 1);
});

test('roster reports autoEnrollNewHires true, defaults missing field to false, and unlinked is false', async () => {
  positions = [
    { _id: 'p1', name: 'Analyst', department: 'Ops', autoEnrollNewHires: true },
    { _id: 'p2', name: 'Clerk', department: 'Ops' },
  ];
  employees = [];
  modules = [];
  studentCounts = { p1: 0, p2: 0 };

  const roster = await service.getPositionRoster();
  const p1 = roster.results.find((r) => r.id === 'p1');
  const p2 = roster.results.find((r) => r.id === 'p2');

  assert.equal(p1.autoEnrollNewHires, true);
  assert.equal(p2.autoEnrollNewHires, false);
  assert.equal(Object.prototype.hasOwnProperty.call(p2, 'autoEnrollNewHires'), true);

  // Force an unlinked row and confirm the flag is false there too.
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
  const roster2 = await service.getPositionRoster();
  const unlinked = roster2.results.find((r) => r.unlinked === true);
  assert.ok(unlinked);
  assert.equal(unlinked.autoEnrollNewHires, false);
});
