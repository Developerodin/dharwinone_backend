import test, { before, mock } from 'node:test';
import assert from 'node:assert/strict';

const findByIdMock = mock.fn();
const queryStudentsMock = mock.fn(async () => ({ results: [], page: 1, limit: 10, totalPages: 0, totalResults: 0 }));
const resolveStudentIdsForPositionsMock = mock.fn(async () => []);

mock.module('../../models/trainingModule.model.js', {
  exports: { default: { findById: findByIdMock } },
});

mock.module('../student.service.js', {
  namedExports: { queryStudents: queryStudentsMock },
});

mock.module('../positionEnrollment.service.js', {
  namedExports: { resolveStudentIdsForPositions: resolveStudentIdsForPositionsMock },
});

mock.module('../../config/s3.js', {
  namedExports: { generatePresignedDownloadUrl: async () => 'https://example.test/file' },
});

mock.module('../upload.service.js', {
  namedExports: { uploadFileToS3: async () => ({ key: 'k' }) },
});

mock.module('../../config/logger.js', {
  exports: {
    default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

let service;
before(async () => {
  service = await import('../trainingModule.service.js');
});

test('queryEmployeesForModule filters by resolver student ids and omits position', async () => {
  findByIdMock.mock.resetCalls();
  queryStudentsMock.mock.resetCalls();
  resolveStudentIdsForPositionsMock.mock.resetCalls();

  findByIdMock.mock.mockImplementation(() => ({
    select: () =>
      Promise.resolve({
        positions: ['507f1f77bcf86cd799439011', '507f191e810c19729de860ea'],
        moduleName: 'Safety',
      }),
  }));
  resolveStudentIdsForPositionsMock.mock.mockImplementation(async () => ['s1', 's2']);
  queryStudentsMock.mock.mockImplementation(async () => ({
    results: [{ id: 's1' }],
    page: 1,
    limit: 10,
    totalPages: 1,
    totalResults: 1,
  }));

  const filter = { search: 'ann' };
  const options = { page: 2, limit: 5 };
  await service.queryEmployeesForModule('mod1', filter, options);

  assert.equal(resolveStudentIdsForPositionsMock.mock.callCount(), 1);
  assert.deepEqual(resolveStudentIdsForPositionsMock.mock.calls[0].arguments[0], [
    '507f1f77bcf86cd799439011',
    '507f191e810c19729de860ea',
  ]);
  assert.equal(queryStudentsMock.mock.callCount(), 1);
  const handedFilter = queryStudentsMock.mock.calls[0].arguments[0];
  assert.deepEqual(handedFilter._id, { $in: ['s1', 's2'] });
  assert.equal(Object.prototype.hasOwnProperty.call(handedFilter, 'position'), false);
  assert.equal(handedFilter.status, 'active');
  assert.equal(handedFilter.search, 'ann');
});

test('queryEmployeesForModule returns empty page when resolver finds no students', async () => {
  findByIdMock.mock.resetCalls();
  queryStudentsMock.mock.resetCalls();
  resolveStudentIdsForPositionsMock.mock.resetCalls();

  findByIdMock.mock.mockImplementation(() => ({
    select: () => Promise.resolve({ positions: ['507f1f77bcf86cd799439011'], moduleName: 'Safety' }),
  }));
  resolveStudentIdsForPositionsMock.mock.mockImplementation(async () => []);

  const result = await service.queryEmployeesForModule('mod1', {}, { page: 3, limit: 20 });

  assert.deepEqual(result, {
    results: [],
    page: 3,
    limit: 20,
    totalPages: 0,
    totalResults: 0,
  });
  assert.equal(queryStudentsMock.mock.callCount(), 0);
});
