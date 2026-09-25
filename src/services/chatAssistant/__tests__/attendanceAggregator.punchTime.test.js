import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPunchIST } from '../attendanceAggregator.js';

describe('formatPunchIST', () => {
  it('renders 03:30Z as 09:00 IST', () => {
    assert.equal(formatPunchIST(new Date('2026-09-25T03:30:00Z')), '09:00');
  });
  it('returns null for missing', () => {
    assert.equal(formatPunchIST(null), null);
  });
});
