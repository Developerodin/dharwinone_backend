import test from 'node:test';
import assert from 'node:assert/strict';

import { auditMatrix } from '../../scripts/assert-permission-matrix-enforced.mjs';

/**
 * Guards the RBAC permission matrix against drift: every checkbox row in the frontend
 * PERMISSION_SECTIONS must map to >= 1 enforcing backend guard, or be explicitly
 * allowlisted in scripts/assert-permission-matrix-enforced.mjs (INTENTIONALLY_UNENFORCED).
 *
 * Skips (does not fail) when the frontend repo isn't checked out alongside the backend,
 * so this test is non-blocking in backend-only CI. Set FRONTEND_DIR to point at the
 * frontend checkout, or STRICT=1 to make absence fatal.
 */
test('every permission-matrix row is enforced or explicitly allowlisted', (t) => {
  const r = auditMatrix();

  if (r.missing) {
    t.skip('frontend matrix (uat.dharwin.frontend/shared/lib/roles-permissions.ts) not found — set FRONTEND_DIR');
    return;
  }

  assert.equal(
    r.deadUnexpected.length,
    0,
    `Matrix rows with no enforcing guard and not allowlisted: ${r.deadUnexpected.map((x) => x.prefix).join(', ')}`
  );
  assert.equal(
    r.staleAllowlist.length,
    0,
    `Allowlisted rows that are now enforced (delete them from INTENTIONALLY_UNENFORCED): ${r.staleAllowlist.join(', ')}`
  );
  assert.equal(
    r.unsatisfiableGuards.length,
    0,
    `Routes guard on keys no matrix row can grant (wrong-key, super-user-only): ${r.unsatisfiableGuards.join(', ')}`
  );
  assert.equal(
    r.staleRestricted.length,
    0,
    `KNOWN_RESTRICTED_KEYS entries no longer unsatisfiable (delete them): ${r.staleRestricted.join(', ')}`
  );
});
