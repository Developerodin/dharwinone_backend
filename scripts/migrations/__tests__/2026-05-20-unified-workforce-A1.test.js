import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATION_VERSION,
  ENUM_TO_TEAM_NAME,
  isAlreadyMigrated,
  decideOrphanReason,
  buildBeforeFingerprint,
  buildMigrationOps,
} from '../2026-05-20-unified-workforce-A1.js';

test('MIGRATION_VERSION is the dated identifier', () => {
  assert.equal(MIGRATION_VERSION, '2026-05-20-unified-workforce-A1');
});
test('ENUM_TO_TEAM_NAME maps the three legacy enum values', () => {
  assert.equal(ENUM_TO_TEAM_NAME.team_ui, 'UI Team');
  assert.equal(ENUM_TO_TEAM_NAME.team_react, 'React Team');
  assert.equal(ENUM_TO_TEAM_NAME.team_testing, 'Testing Team');
});
test('isAlreadyMigrated true when the a1MigratedAt marker is set', () => {
  assert.equal(isAlreadyMigrated({ a1MigratedAt: new Date() }), true);
});
test('isAlreadyMigrated false for an unmarked row', () => {
  assert.equal(isAlreadyMigrated({ teamGroup: 'team_ui', name: 'Jane' }), false);
});
test('decideOrphanReason maps candidate counts', () => {
  assert.equal(decideOrphanReason(0), 'no_email_match');
  assert.equal(decideOrphanReason(1), null);
  assert.equal(decideOrphanReason(2), 'ambiguous_match');
});
test('buildBeforeFingerprint captures the reversible legacy fields', () => {
  const fp = buildBeforeFingerprint({
    name: 'Jane',
    email: 'j@x.com',
    position: 'Sr',
    teamGroup: 'team_react',
    extra: 'ignored',
  });
  assert.deepEqual(fp, { name: 'Jane', email: 'j@x.com', position: 'Sr', teamGroup: 'team_react' });
});
test('buildMigrationOps links a row when exactly one Employee matches', () => {
  const emp = { _id: 'e1', designation: 'Engineer', department: 'Eng' };
  const empByEmail = new Map([['jane@x.com', [emp]]]);
  const res = buildMigrationOps(
    { _id: 'r1', email: 'JANE@x.com', teamGroup: 'team_react', name: 'Jane', position: 'Senior' },
    { teamMap: { team_react: 't-react' }, empByEmail }
  );
  assert.equal(res.skipped, false);
  assert.equal(res.orphan, false);
  assert.equal(res.op.updateOne.update.$set.employeeId, 'e1');
  assert.equal(res.op.updateOne.update.$set.teamId, 't-react');
  assert.equal(res.op.updateOne.update.$set.roleSnapshot.designation, 'Engineer');
});
test('buildMigrationOps makes an orphan when no Employee matches', () => {
  const res = buildMigrationOps(
    { _id: 'r2', email: 'ghost@x.com', teamGroup: 'team_ui', name: 'Ghost' },
    { teamMap: { team_ui: 't-ui' }, empByEmail: new Map() }
  );
  assert.equal(res.orphan, true);
  assert.equal(res.op.updateOne.update.$set.legacyName, 'Ghost');
  assert.equal(res.op.updateOne.update.$set.orphanReason, 'no_email_match');
});
test('buildMigrationOps skips an already-migrated row', () => {
  const res = buildMigrationOps({ _id: 'r3', a1MigratedAt: new Date() }, { teamMap: {}, empByEmail: new Map() });
  assert.deepEqual(res, { skipped: true });
});
