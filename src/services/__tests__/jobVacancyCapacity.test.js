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
