import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSalaryRange, formatJobSalaryRange } from '../jobFieldMap.js';

describe('formatSalaryRange', () => {
  it('formats a min/max range with a space and en dash, comma-grouped', () => {
    const out = formatSalaryRange({ min: 50000, max: 80000, currency: 'USD' });
    assert.equal(out, '$50,000 – $80,000');
  });

  it('labels a lone lower bound as "from"', () => {
    assert.equal(formatSalaryRange({ min: 50000, currency: 'INR' }), 'from ₹50,000');
  });

  it('labels a lone upper bound as "up to"', () => {
    assert.equal(formatSalaryRange({ max: 80000, currency: 'USD' }), 'up to $80,000');
  });

  it('falls back to a plain grouped number + code for an invalid currency', () => {
    assert.equal(formatSalaryRange({ min: 1000, max: 2000, currency: 'NOTREAL' }), '1,000 NOTREAL – 2,000 NOTREAL');
  });

  it('defaults to USD when currency is missing', () => {
    assert.equal(formatSalaryRange({ min: 1000, max: 2000 }), '$1,000 – $2,000');
  });

  it('returns null when neither bound is set', () => {
    assert.equal(formatSalaryRange({ currency: 'USD' }), null);
    assert.equal(formatSalaryRange(null), null);
  });
});

describe('formatJobSalaryRange', () => {
  it('reads salaryRange off the projected fields object', () => {
    assert.equal(formatJobSalaryRange({ salaryRange: { min: 50000, max: 80000, currency: 'USD' } }), '$50,000 – $80,000');
  });

  it('returns null when fields has no salaryRange', () => {
    assert.equal(formatJobSalaryRange({}), null);
  });
});
