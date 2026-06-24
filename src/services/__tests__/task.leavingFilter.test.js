import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectLeavingOwners } from '../task.service.js';

const NOW = new Date('2026-06-23T10:00:00.000Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);

describe('selectLeavingOwners', () => {
  it('returns owner ids for soon + resigned, drops out-of-window and ownerless', () => {
    const emps = [
      { owner: 'u1', resignDate: daysFromNow(-2) }, // resigned
      { owner: 'u2', resignDate: daysFromNow(5) }, // soon
      { owner: 'u3', resignDate: daysFromNow(40) }, // out of window
      { owner: null, resignDate: daysFromNow(1) }, // no owner
    ];
    assert.deepEqual(selectLeavingOwners(emps, NOW).sort(), ['u1', 'u2']);
  });

  it('returns empty array when no employees are leaving', () => {
    assert.deepEqual(selectLeavingOwners([], NOW), []);
    assert.deepEqual(selectLeavingOwners([{ owner: 'u1', resignDate: daysFromNow(40) }], NOW), []);
  });
});
