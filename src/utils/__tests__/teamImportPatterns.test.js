import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredEmployee } from '../teamImportPatterns.js';

test('null/undefined employee → employee_not_found', () => {
  assert.deepEqual(isIgnoredEmployee(null), { ignored: true, reason: 'employee_not_found' });
});
test('inactive employee → inactive_or_resigned', () => {
  assert.deepEqual(
    isIgnoredEmployee({ name: 'Asha', email: 'a@x.com', isActive: false }),
    { ignored: true, reason: 'inactive_or_resigned' }
  );
});
test('dummy name → dummy_name_pattern', () => {
  for (const name of ['Test User', 'Dummy Bob', 'demo account', 'X (Resigned)', 'Bench Dev', 'archived user']) {
    const r = isIgnoredEmployee({ name, email: 'real@x.com', isActive: true });
    assert.equal(r.ignored, true, name);
    assert.equal(r.reason, 'dummy_name_pattern', name);
  }
});
test('dummy email → dummy_email_pattern', () => {
  for (const email of ['test@x.com', 'noreply@x.com', 'no-reply@x.com', 'dummy@x.com', 'demo@x.com']) {
    const r = isIgnoredEmployee({ name: 'Real', email, isActive: true });
    assert.equal(r.ignored, true, email);
    assert.equal(r.reason, 'dummy_email_pattern', email);
  }
});
test('clean employee → not ignored', () => {
  assert.deepEqual(
    isIgnoredEmployee({ name: 'Asha Sharma', email: 'asha@dharwin.com', isActive: true }),
    { ignored: false }
  );
});
