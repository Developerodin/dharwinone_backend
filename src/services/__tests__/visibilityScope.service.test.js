import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let meetingRows = [];
let internalMeetingRows = [];
let tenantUserRows = [];
let isAdmin = false;
let isRecruiter = false;
let isSalesAgent = false;

mock.module('../../models/meeting.model.js', {
  defaultExport: { find: () => ({ lean: async () => meetingRows }) },
});
mock.module('../../models/internalMeeting.model.js', {
  defaultExport: { find: () => ({ lean: async () => internalMeetingRows }) },
});
mock.module('../../models/user.model.js', {
  defaultExport: { find: () => ({ lean: async () => tenantUserRows }) },
});
mock.module('../../models/employee.model.js', {
  defaultExport: { find: () => ({ lean: async () => [] }) },
});
mock.module('../../models/job.model.js', {
  defaultExport: { find: () => ({ lean: async () => [] }) },
});
mock.module('../../utils/roleHelpers.js', {
  namedExports: {
    userIsAdmin: async () => isAdmin,
    userHasRecruiterRole: async () => isRecruiter,
    userIsSalesAgent: async () => isSalesAgent,
  },
});

const scopeServicePromise = import('../visibilityScope.service.js');

test('visibilityScope recordingScope returns scoped meeting ids', async () => {
  meetingRows = [];
  internalMeetingRows = [{ meetingId: 'mk-1' }];
  tenantUserRows = [];
  isAdmin = false;
  isRecruiter = false;
  isSalesAgent = false;

  const scopeService = await scopeServicePromise;
  const { filter } = await scopeService.recordingScope({ id: 'u1', email: 'x@example.com' }, 'read');
  assert.deepEqual(filter, { meetingId: { $in: ['mk-1'] } });
});

test('visibilityScope candidateScope supports sales-agent referral scope', async () => {
  meetingRows = [];
  internalMeetingRows = [];
  tenantUserRows = [];
  isAdmin = false;
  isRecruiter = false;
  isSalesAgent = true;

  const scopeService = await scopeServicePromise;
  const { filter } = await scopeService.candidateScope({ id: 'u7', adminId: 'a1' }, 'read');
  assert.deepEqual(filter, { adminId: 'a1', $or: [{ owner: 'u7' }, { referredByUserId: 'u7' }] });
});
