import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { phraseToDateWindow, toResolveDateWindowArgs } from '../phraseToDateWindow.js';

const NOW = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07

describe('phraseToDateWindow', () => {
  it('maps during July to a calendar month window', () => {
    const p = phraseToDateWindow('how many employees resigned during July', NOW);
    assert.equal(p.needsClarification, undefined);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
    assert.deepEqual(toResolveDateWindowArgs(p), { month: '2026-07' });
  });

  it('maps before July to an end-of-June inclusive range', () => {
    const p = phraseToDateWindow('resigned before July 2026', NOW);
    assert.equal(p.relation, 'before');
    assert.equal(p.toDate, '2026-06-30');
    assert.equal(p.fromDate, '1970-01-01');
  });

  it('asks for clarification on bare July (before vs during)', () => {
    const bare = phraseToDateWindow('employees who resigned July', NOW);
    assert.equal(bare.needsClarification, true);
    assert.match(bare.clarifyingQuestion, /during|before/i);
    assert.equal(bare.month, '2026-07');
  });

  it('accepts YYYY-MM as during that month', () => {
    const p = phraseToDateWindow('resignations in 2026-07', NOW);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
  });

  it('parses an explicit ISO range', () => {
    const p = phraseToDateWindow('from 2026-07-01 to 2026-07-31', NOW);
    assert.equal(p.fromDate, '2026-07-01');
    assert.equal(p.toDate, '2026-07-31');
  });

  it('maps this month / last month', () => {
    assert.equal(phraseToDateWindow('this month', NOW).month, '2026-08');
    assert.equal(phraseToDateWindow('last month', NOW).month, '2026-07');
  });

  it('returns null when no date phrase is present', () => {
    assert.equal(phraseToDateWindow('how many employees'), null);
  });
});
