import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentity } from '../orphanResolver.js';

describe('resolveIdentity', () => {
  it('uses owner User fields when both present', () => {
    const out = resolveIdentity(
      { fullName: 'Old Name', email: 'old@e.co', phoneNumber: '111', employeeId: 'DBS1' },
      { name: 'New Name', email: 'new@e.co', phoneNumber: '222', roleNames: ['Employee', 'Agent'] }
    );
    assert.equal(out.name, 'New Name');
    assert.equal(out.email, 'new@e.co');
    assert.equal(out.phone, '222');
    assert.deepEqual(out.role, ['Employee', 'Agent']);
    assert.equal(out._orphan, false);
  });

  it('falls back to Employee fields when owner User missing', () => {
    const out = resolveIdentity(
      { fullName: 'Solo Emp', email: 'solo@e.co', phoneNumber: '333', employeeId: 'DBS2' },
      null
    );
    assert.equal(out.name, 'Solo Emp');
    assert.equal(out.email, 'solo@e.co');
    assert.equal(out.phone, '333');
    assert.deepEqual(out.role, ['Employee']);
    assert.equal(out._orphan, true);
  });

  it('synthesises label when both fullName and User.name absent', () => {
    const out = resolveIdentity({ employeeId: 'DBS9' }, null);
    assert.equal(out.name, 'Employee DBS9');
    assert.equal(out.email, null);
    assert.equal(out.phone, null);
    assert.equal(out._orphan, true);
  });

  it('returns null when employee absent and user absent', () => {
    assert.equal(resolveIdentity(null, null), null);
  });

  it('never emits the literal string N/A', () => {
    const out = resolveIdentity({ employeeId: 'DBS3' }, null);
    for (const v of Object.values(out)) {
      assert.notEqual(v, 'N/A', 'must not emit N/A literal');
    }
  });

  it('preserves _id from User when available, else Employee.owner', () => {
    const o1 = resolveIdentity({ owner: 'emp-owner-id' }, { _id: 'user-id' });
    assert.equal(o1._id, 'user-id');
    const o2 = resolveIdentity({ owner: 'emp-owner-id' }, null);
    assert.equal(o2._id, 'emp-owner-id');
  });
});
