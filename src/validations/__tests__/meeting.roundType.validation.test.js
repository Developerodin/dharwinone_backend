import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeeting, patchMeetingLinkage } from '../meeting.validation.js';
import { INTERVIEW_ROUND_TYPES } from '../../constants/interviewLinkage.js';

/**
 * These schemas used to hardcode seven of the nine round types. 'panel' and 'hr' were
 * offered by the schedule form, enumerated by the Mongoose model and re-checked in
 * meeting.service.js — and then rejected here, so choosing either 400ed the whole request
 * before it reached any of them. This file exists so that list cannot drift again.
 */

/** The minimum createMeeting accepts, so a failure here can only be about round.type. */
const base = {
  title: 'Interview',
  scheduledAt: new Date().toISOString(),
  durationMinutes: 30,
  hosts: [{ email: 'interviewer@example.com' }],
};

test('createMeeting accepts every declared round type', () => {
  for (const type of INTERVIEW_ROUND_TYPES) {
    const { error } = createMeeting.body.validate({ ...base, round: { type } });
    assert.equal(error, undefined, `round type rejected on create: ${type}`);
  }
});

/**
 * PATCH /meetings/:id deliberately refuses `round` — the linkage endpoint owns it, and
 * carries the same enum, so it needed the same fix.
 */
test('patchMeetingLinkage accepts every declared round type', () => {
  for (const type of INTERVIEW_ROUND_TYPES) {
    const { error } = patchMeetingLinkage.body.validate({ round: { type }, expectedRevision: 0 });
    assert.equal(error, undefined, `round type rejected on linkage patch: ${type}`);
  }
});

test('a round type outside the constant is still rejected', () => {
  // Widening the list must not have turned the field into a free string.
  for (const type of ['group_discussion', 'PANEL', '']) {
    assert.ok(
      createMeeting.body.validate({ ...base, round: { type } }).error,
      `round type should be rejected: ${JSON.stringify(type)}`
    );
  }
});

test('panel and hr are the two that were missing', () => {
  // Named explicitly so a future edit that drops them fails here rather than in the UI.
  for (const type of ['panel', 'hr']) {
    assert.ok(INTERVIEW_ROUND_TYPES.includes(type), `constant lost round type: ${type}`);
    assert.equal(createMeeting.body.validate({ ...base, round: { type } }).error, undefined);
  }
});
