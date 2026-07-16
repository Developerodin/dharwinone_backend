import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveApiPermissions } from '../services/permission.service.js';

// Regression: the "Help & Support access" role toggle stores the standalone permission
// `devTickets.view` (already in final API form, no `domain:actions` colon). deriveApiPermissions
// used to skip colon-less strings, so it was silently dropped from authContext.permissions and
// every /dev-tickets API returned 403 even with the toggle ON. It must pass through verbatim.
test('deriveApiPermissions: standalone devTickets.view passes through verbatim', () => {
  const derived = deriveApiPermissions(new Set(['devTickets.view']));
  assert.equal(derived.has('devTickets.view'), true);
});

test('deriveApiPermissions: colon-less non-standalone strings are still dropped', () => {
  const derived = deriveApiPermissions(new Set(['garbage.string']));
  assert.equal(derived.has('garbage.string'), false);
});
