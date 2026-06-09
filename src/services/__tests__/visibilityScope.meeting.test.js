import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = '507f1f77bcf86cd799439011';
const SUB_ADMIN = '507f1f77bcf86cd799439012';
const AGENT = '507f1f77bcf86cd799439013';

test('meetingScope: administrator with interviews.read gets tenant-wide filter', async (t) => {
  t.mock.module('../../utils/roleHelpers.js', {
    namedExports: {
      userCanViewAllInterviewsForListing: async () => true,
      userHasRecruiterRole: async () => false,
      userIsAdmin: async () => true,
      userIsSalesAgent: async () => false,
    },
  });

  const userFindMock = mock.fn(() => ({
    lean: async () => [{ _id: AGENT }],
  }));
  t.mock.module('../../models/user.model.js', {
    defaultExport: { find: userFindMock },
  });

  const { meetingScope } = await import('../visibilityScope.service.js?t=admin-read');

  const { filter, scopeDebug } = await meetingScope(
    { _id: SUB_ADMIN, adminId: ROOT, email: 'admin@example.com' },
    'read'
  );

  assert.equal(scopeDebug.role, 'interview_listing');
  assert.ok(filter.$or);
  assert.equal(filter.$or.length, 2);
  assert.equal(String(filter.$or.find((c) => c.tenantId)?.tenantId), ROOT);
  const createdByIds = filter.$or.find((c) => c.createdBy)?.createdBy.$in.map(String) || [];
  assert.ok(createdByIds.includes(ROOT));
  assert.ok(createdByIds.includes(AGENT));
});

test('meetingScope: user without listing permission sees only own meetings', async (t) => {
  t.mock.module('../../utils/roleHelpers.js', {
    namedExports: {
      userCanViewAllInterviewsForListing: async () => false,
      userHasRecruiterRole: async () => false,
      userIsAdmin: async () => false,
      userIsSalesAgent: async () => false,
    },
  });

  const { meetingScope } = await import('../visibilityScope.service.js?t=self-only');

  const { filter, scopeDebug } = await meetingScope(
    { _id: AGENT, email: 'agent@example.com' },
    'read'
  );

  assert.equal(scopeDebug.role, 'self');
  assert.ok(filter.$or);
  assert.equal(filter.$or.some((clause) => clause.createdBy), true);
});
