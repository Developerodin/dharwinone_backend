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

const seedTwoPositions = () => {
  positions = [
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Alpha Role', department: 'Ops' },
    { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Beta Role', department: 'Eng' },
  ];
  employees = [
    {
      _id: 'e1',
      fullName: 'Ann Alpha',
      email: 'a@ex.com',
      position: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    },
    {
      _id: 'e2',
      fullName: 'Bob Beta',
      email: 'b@ex.com',
      position: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    },
    {
      _id: 'e3',
      fullName: 'Bea Beta',
      email: 'bea@ex.com',
      position: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    },
  ];
  modules = [
    {
      _id: 'm1',
      moduleName: 'Course A',
      positions: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      categories: ['cccccccccccccccccccccccc'],
    },
    {
      _id: 'm2',
      moduleName: 'Course B',
      positions: ['bbbbbbbbbbbbbbbbbbbbbbbb'],
      categories: ['dddddddddddddddddddddddd'],
    },
  ];
  studentCounts = { aaaaaaaaaaaaaaaaaaaaaaaa: 1, bbbbbbbbbbbbbbbbbbbbbbbb: 2 };
};

test('roster without limit returns all matching rows in a paginated envelope', async () => {
  seedTwoPositions();
  const roster = await service.getPositionRoster();
  assert.equal(roster.totalResults, 2);
  assert.equal(roster.results.length, 2);
  assert.equal(roster.page, 1);
});

test('roster search filters by position name', async () => {
  seedTwoPositions();
  const roster = await service.getPositionRoster({ search: 'alpha' }, { page: 1, limit: 50 });
  assert.equal(roster.totalResults, 1);
  assert.equal(roster.results[0].name, 'Alpha Role');
});

test('roster folderIds OR-filters by module category', async () => {
  seedTwoPositions();
  const roster = await service.getPositionRoster(
    { folderIds: 'dddddddddddddddddddddddd' },
    { page: 1, limit: 50 }
  );
  assert.equal(roster.totalResults, 1);
  assert.equal(roster.results[0].id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
});

test('roster sortBy employees:desc with stable id secondary', async () => {
  seedTwoPositions();
  const roster = await service.getPositionRoster(
    {},
    { sortBy: 'employees:desc,_id:asc', page: 1, limit: 50 }
  );
  assert.equal(roster.results[0].id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(roster.results[1].id, 'aaaaaaaaaaaaaaaaaaaaaaaa');
});

test('roster page/limit slices server-side', async () => {
  seedTwoPositions();
  const page1 = await service.getPositionRoster({}, { sortBy: 'name:asc', page: 1, limit: 1 });
  const page2 = await service.getPositionRoster({}, { sortBy: 'name:asc', page: 2, limit: 1 });
  assert.equal(page1.totalResults, 2);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.results.length, 1);
  assert.equal(page1.results[0].name, 'Alpha Role');
  assert.equal(page2.results[0].name, 'Beta Role');
});

test('unknown sort field is ignored (default name order)', async () => {
  seedTwoPositions();
  const roster = await service.getPositionRoster({}, { sortBy: 'bogus:asc', page: 1, limit: 50 });
  assert.equal(roster.results[0].name, 'Alpha Role');
  assert.equal(roster.results[1].name, 'Beta Role');
});
