import test from 'node:test';
import assert from 'node:assert/strict';

test('devTicket.service query and analytics', async () => {
  let capturedFilter = null;
  test.mock.module('../../models/devTicket.model.js', {
    defaultExport: {
      paginate: async (filter) => {
        capturedFilter = filter;
        return { results: [], page: 1, limit: 10, totalPages: 0, totalResults: 0 };
      },
      aggregate: async () => [
        {
          statusCounts: [{ _id: 'Open', count: 1 }],
          severityCounts: [],
          priorityCounts: [],
          environmentCounts: [],
          topModules: [],
          openByAssignee: [],
          resolverLeaderboard: [],
          oldestOpen: [],
          totalsAgg: [{ total: 2, open: 1, resolved: 1, avgResolutionMs: 3600000 }],
          reopenAgg: [{ reopened: 0, total: 2 }],
        },
      ],
      find: () => ({
        select: () => ({
          lean: async () => [],
        }),
      }),
      populate: async function () { return this; },
    },
  });
  test.mock.module('../../config/s3.js', { namedExports: { generatePresignedDownloadUrl: async (k) => `https://signed/${k}` } });
  test.mock.module('../upload.service.js', { namedExports: { uploadMultipleFilesToS3: async () => [] } });
  test.mock.module('../notification.service.js', { namedExports: { notify: async () => {} } });
  test.mock.module('../../config/logger.js', { defaultExport: { warn: () => {}, info: () => {} } });
  test.mock.module('../../models/user.model.js', {
    defaultExport: { find: async () => [], findById: async () => null },
  });
  test.mock.module('../../utils/roleHelpers.js', {
    namedExports: { userIsAdmin: async (user) => Boolean(user?.isAdmin) },
  });

  const { queryDevTickets, getDevTicketAnalytics } = await import('../devTicket.service.js');

  const user = { id: 'u1', name: 'Tester' };
  const result = await queryDevTickets({}, { page: 1, limit: 10 }, user);
  assert.equal(typeof result.page, 'number');
  assert.ok(Array.isArray(result.results));

  await queryDevTickets({ environment: 'Staging' }, { page: 1, limit: 10 }, user);
  assert.equal(capturedFilter.environment, 'Staging');

  const analytics = await getDevTicketAnalytics({ id: 'u1' });
  assert.ok(analytics.totals);
  assert.ok(analytics.reopen);
  assert.ok(analytics.statusCounts);
  assert.ok(analytics.trend);
  assert.ok(analytics.resolverLeaderboard);
  assert.ok(analytics.oldestOpen);
});
