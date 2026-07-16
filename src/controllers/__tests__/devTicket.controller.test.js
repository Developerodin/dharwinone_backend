import test from 'node:test';
import assert from 'node:assert/strict';
import pick from '../../utils/pick.js';

const LIST_FILTER_KEYS = ['status', 'priority', 'severity', 'module', 'environment', 'label', 'search', 'scope'];

test('list forwards environment query param to service filter', () => {
  const query = {
    status: 'Open',
    environment: 'Production',
    page: 2,
    limit: 20,
  };
  const filter = pick(query, LIST_FILTER_KEYS);
  assert.deepEqual(filter, { status: 'Open', environment: 'Production' });
});
