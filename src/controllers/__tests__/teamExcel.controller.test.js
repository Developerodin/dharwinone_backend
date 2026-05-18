/* eslint-disable */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// Mock the service module before importing the controller so the controller's
// `import * as teamExcelService` resolves to our stubs. Requires Node's
// --experimental-test-module-mocks flag at runtime (Node 22+).
const mockRunImport = mock.fn(async () => ({
  summary: { teamsCreated: 1 },
  importLogId: 'l1',
  summaryFileUrl: 'https://s/sum.xlsx',
}));

mock.module('../../services/teamExcel.service.js', {
  namedExports: {
    runImport: mockRunImport,
    runExport: mock.fn(async () => Buffer.from('')),
    buildTemplateWorkbookBuffer: mock.fn(() => Buffer.from('')),
  },
});

// Avoid loading the real S3 + Mongoose model side-effects.
mock.module('../../config/s3.js', {
  namedExports: { generatePresignedDownloadUrl: mock.fn(async () => 'https://s/url') },
});
mock.module('../../models/teamImportLog.model.js', {
  defaultExport: {
    find: mock.fn(() => ({
      sort: () => ({
        skip: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }),
      }),
    })),
    countDocuments: mock.fn(async () => 0),
  },
});

let controller;
before(async () => {
  controller = await import('../teamExcel.controller.js');
});

test('importExcel responds 200 with summary on success', async () => {
  const req = {
    file: { buffer: Buffer.from('x'), originalname: 't.xlsx', size: 1 },
    user: { id: 'u1' },
  };
  let body;
  const res = {
    statusCode: 0,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      body = b;
    },
  };
  await controller.importExcel(req, res, () => {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.summary, { teamsCreated: 1 });
  assert.equal(body.summaryFileUrl, 'https://s/sum.xlsx');
  assert.equal(body.importLogId, 'l1');
});

test('importExcel returns 400 when no file', async () => {
  let err;
  const res = {
    status() {
      return this;
    },
    json() {},
  };
  await controller.importExcel({ user: { id: 'u1' } }, res, (e) => {
    err = e;
  });
  assert.ok(err);
  assert.equal(err.statusCode, 400);
});
