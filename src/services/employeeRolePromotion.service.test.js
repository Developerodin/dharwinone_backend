import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  nextDbsEmployeeIdSerial,
  shouldAssignEmployeeIdNow,
} from '../models/employee.model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoSrc = resolve(__dirname, '..');
const readSrc = (rel) => readFileSync(resolve(repoSrc, rel), 'utf8');

describe('nextDbsEmployeeIdSerial', () => {
  it('returns 1 when no existing ids', () => {
    assert.equal(nextDbsEmployeeIdSerial([]), 1);
    assert.equal(nextDbsEmployeeIdSerial(null), 1);
    assert.equal(nextDbsEmployeeIdSerial(undefined), 1);
  });

  it('returns max+1 from a sparse list', () => {
    assert.equal(
      nextDbsEmployeeIdSerial([
        { employeeId: 'DBS3' },
        { employeeId: 'DBS17' },
        { employeeId: 'DBS9' },
      ]),
      18
    );
  });

  it('ignores rows without DBS prefix', () => {
    assert.equal(
      nextDbsEmployeeIdSerial([
        { employeeId: 'EMP-1' },
        { employeeId: '' },
        { employeeId: null },
        { employeeId: 'DBS5' },
      ]),
      6
    );
  });

  it('matches case-insensitively (legacy lowercase)', () => {
    assert.equal(
      nextDbsEmployeeIdSerial([{ employeeId: 'dbs42' }, { employeeId: 'DBS7' }]),
      43
    );
  });

  it('rejects non-numeric tails', () => {
    assert.equal(
      nextDbsEmployeeIdSerial([
        { employeeId: 'DBS-3' },
        { employeeId: 'DBSXY' },
        { employeeId: 'DBS10' },
      ]),
      11
    );
  });
});

describe('shouldAssignEmployeeIdNow', () => {
  it('false when flag missing (plain candidate creation)', () => {
    assert.equal(shouldAssignEmployeeIdNow({ employeeId: '' }), false);
    assert.equal(shouldAssignEmployeeIdNow({}), false);
  });

  it('false when flag is anything other than strict true', () => {
    assert.equal(
      shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: 'yes' }, employeeId: '' }),
      false
    );
    assert.equal(
      shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: 1 }, employeeId: '' }),
      false
    );
  });

  it('true when flag set and id is missing', () => {
    assert.equal(
      shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: true }, employeeId: '' }),
      true
    );
    assert.equal(shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: true } }), true);
    assert.equal(
      shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: true }, employeeId: '   ' }),
      true
    );
  });

  it('false when flag set but id already exists (idempotent — never regenerate)', () => {
    assert.equal(
      shouldAssignEmployeeIdNow({ $locals: { assignEmployeeIdNow: true }, employeeId: 'DBS42' }),
      false
    );
  });
});

/**
 * Source-level wiring assertions. Catches regressions where someone removes the helper
 * call or weakens the persistence guard. Cheaper than a Mongo integration test.
 */
describe('promotion flow wiring', () => {
  const promotionSrc = readSrc('services/employeeRolePromotion.service.js');
  const userSrc = readSrc('services/user.service.js');
  const modelSrc = readSrc('models/employee.model.js');

  it('promoteCandidateOwnerToEmployeeRole calls ensureEmployeeIdForOwner on first promotion', () => {
    const after$addToSet = promotionSrc.split('$addToSet: { roleIds: employeeRole._id }')[1] || '';
    assert.match(
      after$addToSet,
      /ensureEmployeeIdForOwner\(\s*promoteUid\s*,\s*\{\s*employeeDocId:\s*emp\._id/
    );
  });

  it('promoteCandidateOwnerToEmployeeRole calls ensureEmployeeIdForOwner when user already had Employee role', () => {
    const branch = promotionSrc.split('if (hasEmployee) {')[1] || '';
    const cutoff = branch.indexOf('noopInfo(');
    const inner = cutoff > 0 ? branch.slice(0, cutoff) : branch;
    assert.match(inner, /ensureEmployeeIdForOwner\(\s*promoteUid\s*,/);
  });

  it('updateUserById hooks ensureEmployeeIdForOwner under the HR Employee role check', () => {
    assert.match(userSrc, /getRoleByName\(\s*['"]Employee['"]\s*\)/);
    assert.match(userSrc, /ensureEmployeeIdForOwner\(user\.id\)/);
  });

  it('ensureEmployeeIdForOwner is exported from the promotion service', () => {
    assert.match(promotionSrc, /export\s+async\s+function\s+ensureEmployeeIdForOwner/);
  });

  it('ensureEmployeeIdForOwner is idempotent — short-circuits when id already set', () => {
    const fn = promotionSrc.split('export async function ensureEmployeeIdForOwner')[1] || '';
    const head = fn.slice(0, 800);
    assert.match(head, /if\s*\(\s*emp\.employeeId/);
    assert.match(head, /return\s+emp\.employeeId/);
  });

  it('ensureEmployeeIdForOwner sets the gated flag before saving', () => {
    const fn = promotionSrc.split('export async function ensureEmployeeIdForOwner')[1] || '';
    assert.match(fn, /\$locals\.assignEmployeeIdNow\s*=\s*true/);
    assert.match(fn, /await\s+emp\.save\(\)/);
  });

  it('employee.model.js: pre-save gen is gated on the flag (not isNew)', () => {
    const lines = modelSrc.split('\n');
    const idx = lines.findIndex((l) => l.includes("employeeSchema.pre('save'"));
    assert.ok(idx >= 0, 'first pre-save hook present');
    const block = lines.slice(idx, idx + 30).join('\n');
    assert.match(block, /shouldAssignEmployeeIdNow\(this\)/);
    assert.doesNotMatch(block, /this\.isNew\s*&&\s*\(!this\.employeeId/);
  });

  it('employee.model.js: persistence hook locks employeeId on every update, not just resigned', () => {
    assert.doesNotMatch(modelSrc, /if\s*\(this\.isNew\s*\|\|\s*!this\.resignDate/);
    const persistMatch = modelSrc.match(
      /if \(this\.isNew\) return next\(\);[\s\S]{0,400}?existing\?\.employeeId/
    );
    assert.ok(persistMatch, 'persistence hook restores stored employeeId on update');
  });

  it('promoteCandidateOwnerToEmployeeRole allows employeeId-only when owner is missing', () => {
    const fn = promotionSrc.split('export async function promoteCandidateOwnerToEmployeeRole')[1] || '';
    const head = fn.slice(0, 400);
    assert.match(head, /if\s*\(\s*!ownerUserId\s*&&\s*!preferredId\s*\)/);
    assert.match(fn, /Employee\.findById\(preferredId\)/);
  });
});
