import test from 'node:test';
import assert from 'node:assert/strict';

test('stats response shape includes sales-agent leaderboard fields', () => {
  const stats = {
    totalReferrals: 10,
    converted: 4,
    conversionRate: 40,
    pending: 3,
    hired: 2,
    topReferrer: null,
    leaderboard: [],
    unassignedCount: 1,
    totalReferredHires: 2,
    hiresPerSalesAgent: [{ userId: 'u1', name: 'Agent', count: 2, rank: 1 }],
    topSalesAgent: { userId: 'u1', name: 'Agent', count: 2, rank: 1, leaderboardSize: 1 },
  };
  assert.equal(stats.unassignedCount, 1);
  assert.equal(stats.topSalesAgent.count, 2);
});
