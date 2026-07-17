import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let exportExcel;

before(async () => {
  const realJobService = await import('../../services/job.service.js');
  mock.module('../../services/job.service.js', {
    namedExports: {
      ...realJobService,
      exportJobsToExcel: async (filter) => {
        calls.push(filter);
        return Buffer.from('xlsx');
      },
    },
  });
  ({ exportExcel } = await import('../job.controller.js'));
});

const ID_A = '507f1f77bcf86cd799439011';
const ID_B = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439099';

const fakeRes = () => ({ setHeader() {}, send() {} });
const fakeReq = (body) => ({
  body,
  query: {},
  user: { id: USER_ID, roleIds: [], platformSuperUser: false },
});

test('posted ids scope the export to the visible rows', async () => {
  calls.length = 0;
  await exportExcel(fakeReq({ ids: [ID_A, ID_B] }), fakeRes(), () => {});

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]._id, { $in: [ID_A, ID_B] });
});

test('no ids exports everything in scope; role scoping always passed through', async () => {
  calls.length = 0;
  await exportExcel(fakeReq({}), fakeRes(), () => {});

  assert.equal(calls.length, 1);
  assert.ok(!('_id' in calls[0]), 'must not send an empty _id filter');
  assert.equal(calls[0].userId, USER_ID);
  assert.deepEqual(calls[0].userRoleIds, []);
});
