import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAtsFunnelQuery,
  looksLikeEmployeeAnalytics,
  clarifyAmbiguousJoined,
  guardEmployeeAnalyticsRoute,
} from '../analyticsRouterGuards.js';

describe('analyticsRouterGuards', () => {
  it('detects referral-lead / funnel language', () => {
    assert.equal(isAtsFunnelQuery('how many referral leads this month'), true);
    assert.equal(isAtsFunnelQuery('show the hiring funnel'), true);
    assert.equal(isAtsFunnelQuery('how many employees resigned in July'), false);
  });

  it('blocks employee_analytics for funnel asks', () => {
    const g = guardEmployeeAnalyticsRoute('how many referral leads converted');
    assert.equal(g.block, true);
    assert.ok(g.preferModules.includes('fetch_candidates'));
  });

  it('does not block resign-employee asks', () => {
    assert.equal(guardEmployeeAnalyticsRoute('how many employees resigned in July'), null);
  });

  it('clarifies ambiguous joined without employment or placement hint', () => {
    const c = clarifyAmbiguousJoined('who joined this month');
    assert.equal(c.needsClarification, true);
    assert.match(c.clarifyingQuestion, /joining date|placement|Hired/i);
  });

  it('skips clarification when employment join is explicit', () => {
    assert.equal(
      clarifyAmbiguousJoined('employees who joined this month by joining date'),
      null
    );
  });

  it('skips clarification when placement join is explicit', () => {
    assert.equal(clarifyAmbiguousJoined('placements who joined this month'), null);
  });

  it('recognises employee analytics phrasing', () => {
    assert.equal(looksLikeEmployeeAnalytics('how many unpaid employees'), true);
    assert.equal(looksLikeEmployeeAnalytics('employees who resigned during July'), true);
    assert.equal(looksLikeEmployeeAnalytics('list open jobs'), false);
  });
});
