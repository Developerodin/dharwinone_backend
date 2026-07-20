import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let exportExcel;

before(async () => {
  const realMeetingService = await import('../../services/meeting.service.js');
  mock.module('../../services/meeting.service.js', {
    namedExports: {
      ...realMeetingService,
      queryMeetings: async (filter, options, user) => {
        calls.push({ filter, options, user });
        return { results: [{ title: 'Interview', status: 'ended', interviewResult: 'pending' }] };
      },
    },
  });
  ({ exportExcel } = await import('../meetingExcel.controller.js'));
});

const USER_ID = '507f1f77bcf86cd799439099';

const fakeRes = () => {
  const headers = {};
  return {
    headers,
    setHeader(k, v) {
      headers[k] = v;
    },
    send() {},
  };
};

const fakeReq = ({ query = {}, body = {} } = {}) => ({
  query,
  body,
  user: { id: USER_ID, _id: USER_ID },
});

test('export passes list filters through to queryMeetings on full dataset', async () => {
  calls.length = 0;
  await exportExcel(
    fakeReq({
      query: {
        candidate: 'John',
        recruiter: 'Sarah',
        status: 'ended',
        interviewType: 'Video',
      },
    }),
    fakeRes(),
    () => {}
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].filter.$and);
  assert.equal(calls[0].options.limit, 100000);
  assert.equal(calls[0].options.page, 1);
});

test('posted ids narrow export scope', async () => {
  calls.length = 0;
  const id = '507f1f77bcf86cd799439011';
  await exportExcel(fakeReq({ body: { ids: [id] } }), fakeRes(), () => {});

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].filter._id.$in[0]), id);
});
