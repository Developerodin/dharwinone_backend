import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeeting } from '../meeting.validation.js';

const base = {
  title: 'Tech Interview',
  scheduledAt: new Date('2026-06-01T10:00:00.000Z'),
  durationMinutes: 60,
  hosts: [{ email: 'host@example.com' }],
};

test('valid timezone passes and is normalized', () => {
  const { value, error } = createMeeting.body.validate({ ...base, timezone: 'Asia/Calcutta' });
  assert.equal(error, undefined);
  assert.equal(value.timezone, 'Asia/Kolkata');
});

test('blank timezone is allowed (model default applies)', () => {
  const { error } = createMeeting.body.validate({ ...base, timezone: '' });
  assert.equal(error, undefined);
});

test('garbage timezone is rejected', () => {
  const { error } = createMeeting.body.validate({ ...base, timezone: 'Not/AZone' });
  assert.ok(error);
});

test('agents array is accepted', () => {
  const { value, error } = createMeeting.body.validate({
    ...base,
    agents: [{ id: '507f1f77bcf86cd799439011', name: 'A', email: 'a@example.com' }],
  });
  assert.equal(error, undefined);
  assert.equal(value.agents.length, 1);
});
