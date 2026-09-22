import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

// student.model.js has a default export, so mock it with defaultExport (see
// src/controllers/__tests__/orgStructure.activityLog.test.js for the same idiom).
// config.js loads real credentials via dotenv override:true, so mocking the model
// import is what keeps this test off the network.
let findResult = [];
const findMock = mock.fn(() => ({
  select: () => ({
    lean: async () => findResult,
  }),
}));

let aggregateResult = [];
const aggregateMock = mock.fn(async () => aggregateResult);

mock.module('../../models/student.model.js', {
  exports: { default: { find: findMock, aggregate: aggregateMock } },
});

let service;
before(async () => {
  service = await import('../positionEnrollment.service.js');
});

test('resolveStudentIdsForPositions returns only active students for the given positions, deduped', async () => {
  findMock.mock.resetCalls();
  findResult = [
    { _id: 's1', position: 'p1', status: 'active' },
    { _id: 's2', position: 'p2', status: 'active' },
    { _id: 's1', position: 'p1', status: 'active' },
  ];

  const ids = await service.resolveStudentIdsForPositions(['p1', 'p2']);

  assert.deepEqual(ids.sort(), ['s1', 's2']);
  assert.equal(findMock.mock.callCount(), 1);
  assert.deepEqual(findMock.mock.calls[0].arguments[0], {
    position: { $in: ['p1', 'p2'] },
    status: 'active',
  });
});

test('resolveStudentIdsForPositions returns an empty array for no positions without touching the database', async () => {
  findMock.mock.resetCalls();

  const ids = await service.resolveStudentIdsForPositions([]);

  assert.deepEqual(ids, []);
  assert.equal(findMock.mock.callCount(), 0);
});

test('countStudentsByPosition zero-fills every requested position id and counts active students', async () => {
  aggregateMock.mock.resetCalls();
  const withStudents = '507f1f77bcf86cd799439011';
  const withoutStudents = '507f191e810c19729de860ea';
  aggregateResult = [{ _id: withStudents, n: 3 }];

  const counts = await service.countStudentsByPosition([withStudents, withoutStudents]);

  assert.deepEqual(counts, { [withStudents]: 3, [withoutStudents]: 0 });
  assert.equal(aggregateMock.mock.callCount(), 1);
});

test('countStudentsByPosition returns an empty object for no positions without touching the database', async () => {
  aggregateMock.mock.resetCalls();

  const counts = await service.countStudentsByPosition([]);

  assert.deepEqual(counts, {});
  assert.equal(aggregateMock.mock.callCount(), 0);
});
