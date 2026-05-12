import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedByMeeting,
  isAllowedByChatCall,
} from '../meetingAccess.service.js';

test('isAllowedByMeeting: host email matches', () => {
  const meeting = { hosts: [{ email: 'alice@x.com' }], emailInvites: [], candidate: {}, recruiter: {} };
  assert.equal(isAllowedByMeeting(meeting, { email: 'alice@x.com', role: 'recruiter' }), true);
});

test('isAllowedByMeeting: admin always allowed', () => {
  assert.equal(isAllowedByMeeting({ hosts: [] }, { email: 'whoever', role: 'admin' }), true);
});

test('isAllowedByMeeting: invitee email matches', () => {
  const m = { hosts: [], emailInvites: ['bob@x.com'], candidate: {}, recruiter: {} };
  assert.equal(isAllowedByMeeting(m, { email: 'bob@x.com', role: 'employee' }), true);
});

test('isAllowedByMeeting: random user denied', () => {
  const m = { hosts: [], emailInvites: ['bob@x.com'], candidate: { email: 'c@x.com' }, recruiter: { email: 'r@x.com' } };
  assert.equal(isAllowedByMeeting(m, { email: 'random@x.com', role: 'employee' }), false);
});

test('isAllowedByChatCall: caller or callee allowed', () => {
  const cc = { caller: 'u1', callee: 'u2' };
  assert.equal(isAllowedByChatCall(cc, { _id: 'u1' }), true);
  assert.equal(isAllowedByChatCall(cc, { _id: 'u2' }), true);
  assert.equal(isAllowedByChatCall(cc, { _id: 'u3' }), false);
});
