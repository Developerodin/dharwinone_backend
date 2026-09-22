import test from 'node:test';
import assert from 'node:assert/strict';
import Position from '../position.model.js';
import { updatePosition } from '../../validations/position.validation.js';

test('autoEnrollNewHires round-trips through toJSON with a false default', () => {
  const missing = new Position({ name: `auto-enroll-missing-${Date.now()}` });
  assert.equal(missing.toJSON().autoEnrollNewHires, false);

  const enabled = new Position({
    name: `auto-enroll-on-${Date.now()}`,
    autoEnrollNewHires: true,
  });
  assert.equal(enabled.toJSON().autoEnrollNewHires, true);
});

test('updatePosition schema accepts autoEnrollNewHires', () => {
  const { error, value } = updatePosition.body.validate({ autoEnrollNewHires: false });
  assert.equal(error, undefined);
  assert.equal(value.autoEnrollNewHires, false);
});
