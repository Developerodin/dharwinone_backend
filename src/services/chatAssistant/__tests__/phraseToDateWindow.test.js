import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { phraseToDateWindow, toResolveDateWindowArgs } from '../phraseToDateWindow.js';

const AUG_2026 = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07
const JAN_2026 = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15

describe('phraseToDateWindow', () => {
  it('maps during July to most recent July before/at now (Aug 2026 → 2026-07)', () => {
    const p = phraseToDateWindow('how many employees resigned during July', AUG_2026);
    assert.equal(p.needsClarification, undefined);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
    assert.ok((p.confidence ?? 0) >= 0.9);
    assert.deepEqual(toResolveDateWindowArgs(p), { month: '2026-07' });
  });

  it('maps bare july to most recent calendar July without before/during ask', () => {
    const p = phraseToDateWindow('employees resigned in july', AUG_2026);
    assert.equal(p.needsClarification, undefined);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
  });

  it('maps december in January to previous calendar year', () => {
    const p = phraseToDateWindow('resigned in december', JAN_2026);
    assert.equal(p.month, '2025-12');
    assert.equal(p.relation, 'during');
    assert.equal(p.needsClarification, undefined);
  });

  it('maps before July to an end-of-June inclusive range', () => {
    const p = phraseToDateWindow('resigned before July 2026', AUG_2026);
    assert.equal(p.relation, 'before');
    assert.equal(p.toDate, '2026-06-30');
    assert.equal(p.fromDate, '1970-01-01');
  });

  it('accepts YYYY-MM as during that month', () => {
    const p = phraseToDateWindow('resignations in 2026-07', AUG_2026);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
  });

  it('parses an explicit ISO range', () => {
    const p = phraseToDateWindow('from 2026-07-01 to 2026-07-31', AUG_2026);
    assert.equal(p.fromDate, '2026-07-01');
    assert.equal(p.toDate, '2026-07-31');
  });

  it('maps this month / last month', () => {
    assert.equal(phraseToDateWindow('this month', AUG_2026).month, '2026-08');
    assert.equal(phraseToDateWindow('last month', AUG_2026).month, '2026-07');
  });

  it('maps last quarter to the most recent completed quarter', () => {
    // Aug 2026 → Q2 2026 (Apr–Jun)
    const p = phraseToDateWindow('resignations last quarter', AUG_2026);
    assert.equal(p.needsClarification, undefined);
    assert.equal(p.fromDate, '2026-04-01');
    assert.equal(p.toDate, '2026-06-30');
    assert.equal(p.relation, 'during');
  });

  it('asks clarification for financial year / recent / old / new joiners', () => {
    for (const phrase of [
      'employees in the financial year',
      'recent resignations',
      'old employees who left',
      'new joiners',
    ]) {
      const p = phraseToDateWindow(phrase, AUG_2026);
      assert.equal(p.needsClarification, true, phrase);
      assert.ok(p.clarifyingQuestion, phrase);
      assert.ok((p.confidence ?? 1) < 0.7, phrase);
      assert.doesNotMatch(p.clarifyingQuestion, /which year\??$/i);
    }
  });

  it('maps bare calendar year to a full-year window', () => {
    const p = phraseToDateWindow('employees resigned in 2026', AUG_2026);
    assert.equal(p.fromDate, '2026-01-01');
    assert.equal(p.toDate, '2026-12-31');
    assert.equal(p.relation, 'during');
  });

  it('applies conversation memory year when follow-up is month-only', () => {
    const memory = { lastFromDate: '2026-01-01', lastToDate: '2026-12-31', lastDateLabel: '2026' };
    const p = phraseToDateWindow('only july', AUG_2026, memory);
    assert.equal(p.month, '2026-07');
    assert.equal(p.relation, 'during');
    assert.equal(p.needsClarification, undefined);
    assert.ok((p.confidence ?? 0) >= 0.9);
  });

  it('returns null when no date phrase is present', () => {
    assert.equal(phraseToDateWindow('how many employees'), null);
  });
});
