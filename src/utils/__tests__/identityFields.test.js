import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_FIELD_MAP,
  buildEmployeeMirrorPatch,
  computeIdentityConvergence,
  detectDirectIdentityWrite,
} from '../identityFields.js';

test('IDENTITY_FIELD_MAP has the 5 canonical pairs', () => {
  assert.deepEqual(
    IDENTITY_FIELD_MAP.map((p) => `${p.user}:${p.employee}`).sort(),
    ['countryCode:countryCode', 'email:email', 'name:fullName', 'phoneNumber:phoneNumber', 'profilePicture:profilePicture']
  );
});

test('buildEmployeeMirrorPatch maps name to fullName and lowercases email', () => {
  const patch = buildEmployeeMirrorPatch(
    { name: '  Jane Doe ', email: ' Jane@X.COM ' },
    { fullName: 'Old', email: 'old@x.com', phoneNumber: '123' }
  );
  assert.deepEqual(patch, { fullName: 'Jane Doe', email: 'jane@x.com' });
});

test('buildEmployeeMirrorPatch never clears employee phone from empty user phone', () => {
  const patch = buildEmployeeMirrorPatch({ phoneNumber: '' }, { phoneNumber: '5551234' });
  assert.deepEqual(patch, {});
});

test('buildEmployeeMirrorPatch skips profilePicture when key unchanged, null becomes undefined', () => {
  const same = buildEmployeeMirrorPatch(
    { profilePicture: { key: 'k1', url: 'u' } },
    { profilePicture: { key: 'k1', url: 'old-url' } }
  );
  assert.deepEqual(same, {});
  const cleared = buildEmployeeMirrorPatch(
    { profilePicture: null },
    { profilePicture: { key: 'k1' } }
  );
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'profilePicture'), true);
  assert.equal(cleared.profilePicture, undefined);
});

test('buildEmployeeMirrorPatch omits fields not present in userValues', () => {
  const patch = buildEmployeeMirrorPatch({ name: 'A' }, { fullName: 'B', email: 'b@x.com' });
  assert.deepEqual(patch, { fullName: 'A' });
});

test('computeIdentityConvergence: user non-empty wins into employeeSet', () => {
  const { userSet, employeeSet } = computeIdentityConvergence(
    { name: 'New Name', email: 'u@x.com', phoneNumber: '111', countryCode: 'IN', profilePicture: { key: 'k2' } },
    { fullName: 'Old Name', email: 'u@x.com', phoneNumber: '222', countryCode: 'IN', profilePicture: { key: 'k1' } }
  );
  assert.deepEqual(userSet, {});
  assert.deepEqual(employeeSet, { fullName: 'New Name', phoneNumber: '111', profilePicture: { key: 'k2' } });
});

test('computeIdentityConvergence: empty user field adopts employee value into userSet', () => {
  const { userSet, employeeSet } = computeIdentityConvergence(
    { name: 'Jane', email: 'j@x.com', phoneNumber: '', countryCode: null },
    { fullName: 'Jane', email: 'j@x.com', phoneNumber: '999', countryCode: 'US' }
  );
  assert.deepEqual(employeeSet, {});
  assert.deepEqual(userSet, { phoneNumber: '999', countryCode: 'US' });
});

test('computeIdentityConvergence: equal values is a no-op', () => {
  const { userSet, employeeSet } = computeIdentityConvergence(
    { name: 'J', email: 'j@x.com' },
    { fullName: 'J', email: 'j@x.com' }
  );
  assert.deepEqual(userSet, {});
  assert.deepEqual(employeeSet, {});
});

test('detectDirectIdentityWrite flags identity paths only when not new and unflagged', () => {
  assert.deepEqual(detectDirectIdentityWrite(['fullName', 'shortBio'], false, false), ['fullName']);
  assert.deepEqual(detectDirectIdentityWrite(['profilePicture.key'], false, false), ['profilePicture']);
  assert.deepEqual(detectDirectIdentityWrite(['fullName'], true, false), []);
  assert.deepEqual(detectDirectIdentityWrite(['fullName'], false, true), []);
  assert.deepEqual(detectDirectIdentityWrite(['shortBio'], false, false), []);
});
