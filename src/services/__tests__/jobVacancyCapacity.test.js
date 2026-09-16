/**
 * A job cannot accumulate more Hired applications than it declared openings.
 *
 * The predicate is deliberately total and I/O-free: a job with no declared `vacancies` is uncapped
 * (older postings predate the field), and a job already over capacity stays blocked rather than
 * being retro-corrected.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  getVacancyCapacityBlockReason,
  isVacancyCapacityFull,
} from '../../constants/atsPipeline.js';

test('room left on a single-vacancy job', () => {
  assert.equal(getVacancyCapacityBlockReason(0, 1), null);
  assert.equal(isVacancyCapacityFull(0, 1), false);
});

test('a filled single-vacancy job blocks the next hire and names the fix', () => {
  const reason = getVacancyCapacityBlockReason(1, 1);
  assert.equal(
    reason,
    'All 1 vacancy for this job have been filled (1 hired). Increase the vacancy count on the job to hire another applicant.'
  );
  assert.equal(isVacancyCapacityFull(1, 1), true);
});

test('a multi-vacancy job pluralises and blocks only once full', () => {
  assert.equal(getVacancyCapacityBlockReason(2, 3), null);
  assert.equal(
    getVacancyCapacityBlockReason(3, 3),
    'All 3 vacancies for this job have been filled (3 hired). Increase the vacancy count on the job to hire another applicant.'
  );
});

test('a job already over capacity stays blocked and reports the real hired count', () => {
  // The reported bug state: vacancies 1, hired 2. It must not get worse, and must not be "fixed".
  assert.equal(
    getVacancyCapacityBlockReason(2, 1),
    'All 1 vacancy for this job have been filled (2 hired). Increase the vacancy count on the job to hire another applicant.'
  );
});

test('a job with no declared vacancies is uncapped', () => {
  // Legacy postings predate the field. Guarding them would retroactively block every old req.
  assert.equal(getVacancyCapacityBlockReason(5, null), null);
  assert.equal(getVacancyCapacityBlockReason(5, undefined), null);
  assert.equal(isVacancyCapacityFull(5, null), false);
});

test('a non-positive or unparseable vacancy count is treated as uncapped, never as zero capacity', () => {
  // A 0 or NaN here means "nobody said", not "nobody may be hired" — failing closed would
  // silently freeze hiring on any job with bad data.
  assert.equal(getVacancyCapacityBlockReason(0, 0), null);
  assert.equal(getVacancyCapacityBlockReason(0, -1), null);
  assert.equal(getVacancyCapacityBlockReason(0, 'abc'), null);
});

test('a missing hired count counts as zero', () => {
  assert.equal(getVacancyCapacityBlockReason(undefined, 2), null);
  assert.equal(getVacancyCapacityBlockReason(null, 2), null);
});

/**
 * The assert is the only place that touches the database. It is mocked at the module boundary
 * rather than against a live Mongo, because the behaviour under test is the decision, not the query.
 */
const loadAssert = async ({ vacancies, hired }) => {
  mock.reset();
  mock.module('../../models/job.model.js', {
    defaultExport: {
      findById: () => ({
        select: () => ({ lean: async () => (vacancies === 'missing' ? null : { vacancies }) }),
      }),
    },
  });
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: {
      countDocuments: () => {
        const p = Promise.resolve(hired);
        p.session = () => Promise.resolve(hired);
        return p;
      },
    },
  });
  const mod = await import(`../job.service.js?vacancy-test=${Math.random()}`);
  return mod.assertJobVacancyCapacity;
};

test('assert resolves when the job has room', async () => {
  const assertCapacity = await loadAssert({ vacancies: 2, hired: 1 });
  await assertCapacity('job-1');
});

test('assert throws 409 with a machine-readable code when the job is full', async () => {
  const assertCapacity = await loadAssert({ vacancies: 1, hired: 1 });
  await assert.rejects(
    () => assertCapacity('job-1'),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /All 1 vacancy for this job have been filled/);
      assert.equal(err.errorCode ?? err.meta?.errorCode, 'JOB_VACANCIES_FILLED');
      return true;
    }
  );
});

test('assert resolves for a job with no declared vacancies', async () => {
  const assertCapacity = await loadAssert({ vacancies: null, hired: 9 });
  await assertCapacity('job-1');
});

test('assert resolves when the job row is gone', async () => {
  // A deleted job must not wedge an in-flight offer accept.
  const assertCapacity = await loadAssert({ vacancies: 'missing', hired: 9 });
  await assertCapacity('job-1');
});

test('assert resolves for a falsy job id without querying', async () => {
  const assertCapacity = await loadAssert({ vacancies: 1, hired: 5 });
  await assertCapacity(null);
  await assertCapacity(undefined);
});

const loadCounts = async (aggregateRows) => {
  mock.reset();
  mock.module('../../models/job.model.js', { defaultExport: {} });
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: { aggregate: async () => aggregateRows },
  });
  const mod = await import(`../job.service.js?counts-test=${Math.random()}`);
  return mod.getHiredCountsForJobs;
};

test('hired counts are keyed by stringified job id', async () => {
  const getCounts = await loadCounts([
    { _id: '64b7f9a2c1d4e5f6a7b8c9d0', hired: 2, lastHiredAt: new Date('2026-09-10T00:00:00Z') },
  ]);
  const map = await getCounts(['64b7f9a2c1d4e5f6a7b8c9d0']);
  assert.equal(map.get('64b7f9a2c1d4e5f6a7b8c9d0').hired, 2);
  assert.deepEqual(map.get('64b7f9a2c1d4e5f6a7b8c9d0').lastHiredAt, new Date('2026-09-10T00:00:00Z'));
});

test('a job with no hires is absent from the map, not zero', async () => {
  // Callers distinguish "never hired" from "hired 0 times" by absence; keep that contract.
  const getCounts = await loadCounts([]);
  const map = await getCounts(['64b7f9a2c1d4e5f6a7b8c9d0']);
  assert.equal(map.has('64b7f9a2c1d4e5f6a7b8c9d0'), false);
  assert.equal(map.size, 0);
});

test('an empty or all-falsy id list short-circuits to an empty map', async () => {
  const getCounts = await loadCounts([{ _id: 'x', hired: 1, lastHiredAt: null }]);
  assert.equal((await getCounts([])).size, 0);
  assert.equal((await getCounts([null, undefined, ''])).size, 0);
  assert.equal((await getCounts(undefined)).size, 0);
});

const loadResolveReopen = async () => {
  mock.reset();
  mock.module('../../models/job.model.js', { defaultExport: {} });
  mock.module('../../models/jobApplication.model.js', { defaultExport: {} });
  const mod = await import(`../job.service.js?reopen-test=${Math.random()}`);
  return mod.resolveVacancyReopen;
};

/**
 * The Edit Job form sends `status` on every save, so "did the caller send a status?" is always true
 * and cannot stand in for "did the human change the status?". Getting that wrong made the reopen
 * unreachable from the only screen that edits vacancies — and wiped the flag so it could never
 * reopen later either. These cases pin the distinction.
 */
test('raising vacancies reopens an auto-closed job even when the form re-sends the same status', async () => {
  const resolve = await loadResolveReopen();
  assert.deepEqual(
    resolve({
      autoClosedForVacancies: true,
      prevStatus: 'Closed',
      nextStatus: 'Closed',
      updateStatus: 'Closed', // EditJobClient always sends this
      prevVacancies: 1,
      nextVacancies: 2,
    }),
    { clearFlag: true, reopen: true }
  );
});

test('an explicit status change hands the job back to the human and never reopens', async () => {
  const resolve = await loadResolveReopen();
  assert.deepEqual(
    resolve({
      autoClosedForVacancies: true,
      prevStatus: 'Closed',
      nextStatus: 'Active',
      updateStatus: 'Active',
      prevVacancies: 1,
      nextVacancies: 2,
    }),
    { clearFlag: true, reopen: false }
  );
});

test('a job a human closed is never reopened by raising vacancies', async () => {
  const resolve = await loadResolveReopen();
  assert.deepEqual(
    resolve({
      autoClosedForVacancies: false,
      prevStatus: 'Closed',
      nextStatus: 'Closed',
      updateStatus: 'Closed',
      prevVacancies: 1,
      nextVacancies: 5,
    }),
    { clearFlag: false, reopen: false }
  );
});

test('editing an auto-closed job without touching vacancies leaves the flag intact', async () => {
  // The flag must survive unrelated edits, or a later vacancy raise cannot reopen the job.
  const resolve = await loadResolveReopen();
  assert.deepEqual(
    resolve({
      autoClosedForVacancies: true,
      prevStatus: 'Closed',
      nextStatus: 'Closed',
      updateStatus: 'Closed',
      prevVacancies: 1,
      nextVacancies: undefined,
    }),
    { clearFlag: false, reopen: false }
  );
});

test('lowering or matching the vacancy count does not reopen', async () => {
  const resolve = await loadResolveReopen();
  const base = {
    autoClosedForVacancies: true,
    prevStatus: 'Closed',
    nextStatus: 'Closed',
    updateStatus: 'Closed',
    prevVacancies: 3,
  };
  assert.equal(resolve({ ...base, nextVacancies: 3 }).reopen, false);
  assert.equal(resolve({ ...base, nextVacancies: 2 }).reopen, false);
});

test('an auto-closed job with no previously declared count reopens on any positive raise', async () => {
  const resolve = await loadResolveReopen();
  assert.equal(
    resolve({
      autoClosedForVacancies: true,
      prevStatus: 'Closed',
      nextStatus: 'Closed',
      updateStatus: 'Closed',
      prevVacancies: null,
      nextVacancies: 1,
    }).reopen,
    true
  );
});

const NOW = new Date('2026-09-16T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const loadShouldClose = async () => {
  mock.reset();
  mock.module('../../models/job.model.js', { defaultExport: {} });
  mock.module('../../models/jobApplication.model.js', { defaultExport: {} });
  const mod = await import(`../job.service.js?autoclose-test=${Math.random()}`);
  return mod.shouldAutoCloseForVacancies;
};

test('a job full for more than two days closes', async () => {
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: 1, hired: 1, lastHiredAt: daysAgo(3), now: NOW }), true);
});

test('a job full for less than two days is left alone', async () => {
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: 1, hired: 1, lastHiredAt: daysAgo(1), now: NOW }), false);
});

test('a job with room is never closed however old the last hire', async () => {
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: 3, hired: 1, lastHiredAt: daysAgo(90), now: NOW }), false);
});

test('a job with no declared vacancies is never closed', async () => {
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: null, hired: 9, lastHiredAt: daysAgo(90), now: NOW }), false);
});

test('a job with no hire timestamp is never closed', async () => {
  // No evidence of when it filled means no clock to run — leave it to a human.
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: 1, hired: 1, lastHiredAt: null, now: NOW }), false);
});

test('an over-capacity job closes on the same rule', async () => {
  const should = await loadShouldClose();
  assert.equal(should({ vacancies: 1, hired: 2, lastHiredAt: daysAgo(5), now: NOW }), true);
});

/**
 * The tick has two jobs now, on two different clocks: tell the owner the moment the openings fill,
 * and close the posting two days later. These cover the first one, including the claim that stops a
 * second tick re-mailing the same owner.
 */
const JOB_A = '000000000000000000000a01';

const loadTick = async ({ candidates, rows, claim, notify }) => {
  mock.reset();
  const calls = { notified: [], released: [], closed: [] };
  mock.module('../../models/job.model.js', {
    defaultExport: {
      find: () => ({ select: () => ({ lean: async () => candidates }) }),
      findOneAndUpdate: (filter) => ({ lean: async () => claim(filter) }),
      updateMany: async (filter) => {
        calls.closed.push(filter);
      },
      updateOne: async (filter) => {
        calls.released.push(filter);
      },
    },
  });
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: { aggregate: async () => rows },
  });
  mock.module('../notification.service.js', {
    namedExports: {
      plainTextEmailBody: (message) => message,
      notify: async (userId, options) => {
        calls.notified.push({ userId, options });
        if (notify) await notify();
      },
    },
  });
  const mod = await import(`../job.service.js?tick-test=${Math.random()}`);
  return { run: mod.runVacancyAutoCloseTick, calls };
};

const fullOneVacancy = (lastHiredAt) => ({
  candidates: [{ _id: JOB_A, vacancies: 1, title: 'Node Dev', createdBy: 'user-1' }],
  rows: [{ _id: JOB_A, hired: 1, lastHiredAt }],
  claim: (filter) =>
    filter.vacancyFilledNotifiedAt === null
      ? { _id: JOB_A, vacancies: 1, title: 'Node Dev', createdBy: 'user-1' }
      : null,
});

test('the owner is told as soon as the openings fill, without waiting for the close', async () => {
  // The whole point: "increase the vacancy count" is only actionable while the job is still open.
  const { run, calls } = await loadTick(fullOneVacancy(daysAgo(1)));
  const result = await run({ now: NOW });
  assert.deepEqual(result, { closed: 0, notified: 1 });
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].userId, 'user-1');
  assert.equal(calls.notified[0].options.type, 'job_filled');
  assert.equal(calls.notified[0].options.link, `/ats/jobs/edit/${JOB_A}`);
  assert.match(calls.notified[0].options.email.subject, /Node Dev/);
  assert.equal(calls.closed.length, 0);
});

test('a job already notified is not mailed a second time', async () => {
  // The claim is the record. A tick that runs again over the same full job must find it taken.
  const { run, calls } = await loadTick({ ...fullOneVacancy(daysAgo(1)), claim: () => null });
  assert.deepEqual(await run({ now: NOW }), { closed: 0, notified: 0 });
  assert.equal(calls.notified.length, 0);
});

test('a job with room notifies nobody', async () => {
  const { run, calls } = await loadTick({
    candidates: [{ _id: JOB_A, vacancies: 3, title: 'Node Dev', createdBy: 'user-1' }],
    rows: [{ _id: JOB_A, hired: 1, lastHiredAt: daysAgo(90) }],
    claim: () => assert.fail('a job with room must never be claimed'),
  });
  assert.deepEqual(await run({ now: NOW }), { closed: 0, notified: 0 });
  assert.equal(calls.notified.length, 0);
});

test('a long-full job is both notified and closed in the same tick', async () => {
  const { run, calls } = await loadTick(fullOneVacancy(daysAgo(3)));
  assert.deepEqual(await run({ now: NOW }), { closed: 1, notified: 1 });
  assert.equal(calls.closed.length, 1);
});

test('a failed notify hands the claim back so the next tick retries', async () => {
  // Otherwise the claim silently becomes a permanent "already told them" for a mail never sent.
  const { run, calls } = await loadTick({
    ...fullOneVacancy(daysAgo(1)),
    notify: async () => {
      throw new Error('recipient lookup failed');
    },
  });
  assert.deepEqual(await run({ now: NOW }), { closed: 0, notified: 0 });
  assert.equal(calls.released.length, 1);
  assert.equal(String(calls.released[0]._id), JOB_A);
});

test('immediate hire path notifies the owner without waiting for the tick', async () => {
  mock.reset();
  const calls = { notified: [], released: [] };
  const jobId = JOB_A;
  mock.module('../../models/job.model.js', {
    defaultExport: {
      findById: () => ({
        select: () => ({
          lean: async () => ({ _id: jobId, status: 'Active', jobOrigin: 'internal', vacancies: 1 }),
        }),
      }),
      findOneAndUpdate: (filter) => ({
        lean: async () =>
          filter.vacancyFilledNotifiedAt === null
            ? { _id: jobId, vacancies: 1, title: 'Node Dev', createdBy: 'user-1' }
            : null,
      }),
      updateOne: async (filter) => {
        calls.released.push(filter);
      },
    },
  });
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: { aggregate: async () => [{ _id: jobId, hired: 1, lastHiredAt: daysAgo(0) }] },
  });
  mock.module('../notification.service.js', {
    namedExports: {
      plainTextEmailBody: (message) => message,
      notify: async (userId, options) => {
        calls.notified.push({ userId, options });
      },
    },
  });
  const mod = await import(`../job.service.js?immediate-notify=${Math.random()}`);
  const sent = await mod.notifyJobOwnerIfVacanciesNowFilled(jobId, { now: NOW });
  assert.equal(sent, 1);
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].options.type, 'job_filled');
});

test('immediate notify skips jobs that still have openings', async () => {
  mock.reset();
  const calls = { notified: [] };
  const jobId = JOB_A;
  mock.module('../../models/job.model.js', {
    defaultExport: {
      findById: () => ({
        select: () => ({
          lean: async () => ({ _id: jobId, status: 'Active', jobOrigin: 'internal', vacancies: 3 }),
        }),
      }),
      findOneAndUpdate: () => ({
        lean: async () => {
          assert.fail('must not claim when vacancies remain');
        },
      }),
    },
  });
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: { aggregate: async () => [{ _id: jobId, hired: 1, lastHiredAt: daysAgo(0) }] },
  });
  mock.module('../notification.service.js', {
    namedExports: {
      plainTextEmailBody: (message) => message,
      notify: async (userId, options) => {
        calls.notified.push({ userId, options });
      },
    },
  });
  const mod = await import(`../job.service.js?immediate-skip=${Math.random()}`);
  const sent = await mod.notifyJobOwnerIfVacanciesNowFilled(jobId, { now: NOW });
  assert.equal(sent, 0);
  assert.equal(calls.notified.length, 0);
});
