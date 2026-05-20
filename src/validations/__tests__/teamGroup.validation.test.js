import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamGroup, updateTeamGroup } from '../teamGroup.validation.js';

const oid = '507f1f77bcf86cd799439011';

test('createTeamGroup accepts name only', () => {
  assert.equal(createTeamGroup.body.validate({ name: 'AI Team' }).error, undefined);
});
test('createTeamGroup accepts relatedPositions array', () => {
  assert.equal(createTeamGroup.body.validate({ name: 'AI Team', relatedPositions: [oid] }).error, undefined);
});
test('createTeamGroup rejects non-objectId in relatedPositions', () => {
  assert.ok(createTeamGroup.body.validate({ name: 'X', relatedPositions: ['not-an-id'] }).error);
});
test('updateTeamGroup accepts relatedPositions array', () => {
  const { error } = updateTeamGroup.body.validate({ relatedPositions: [oid] });
  assert.equal(error, undefined);
});
