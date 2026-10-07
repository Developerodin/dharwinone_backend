import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../../config/config.js', {
  defaultExport: {
    bolna: { apiKey: 'test-key', apiBase: 'https://api.bolna.test' },
  },
});

const fetchCalls = [];
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => JSON.stringify({ message: 'not found' }),
  };
};

let bolnaService;

test.before(async () => {
  bolnaService = (await import('../bolna.service.js')).default;
});

test('deleteAgent treats upstream 404 as success (idempotent cleanup)', async () => {
  fetchCalls.length = 0;
  const result = await bolnaService.deleteAgent('agent-missing');
  assert.equal(result.success, true);
  assert.equal(result.notFound, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.method, 'DELETE');
});
