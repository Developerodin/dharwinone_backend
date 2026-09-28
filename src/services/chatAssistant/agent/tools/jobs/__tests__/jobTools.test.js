import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import countJobs from '../countJobs.tool.js';
import listJobs from '../listJobs.tool.js';
import getJob from '../getJob.tool.js';
import rankJobsBySalary from '../rankJobsBySalary.tool.js';
import jobsDomain from '../index.js';
import allDomains from '../../index.js';
import { buildJobSearchClause, MIRROR_EXTERNAL_OR } from '../../../../../job.service.js';

const VIS = { createdBy: 'user-1' };
const USER = { id: 'user-1', roleIds: [] };
const JOB_ID = '64b7f0c2a1b2c3d4e5f60718';

/** True when `clause` appears anywhere inside `filter` (as the filter itself or a nested node). */
function contains(filter, clause) {
  if (isDeepStrictEqual(filter, clause)) return true;
  if (Array.isArray(filter)) return filter.some((f) => contains(f, clause));
  if (filter && typeof filter === 'object' && !(filter instanceof RegExp)) {
    return Object.values(filter).some((v) => contains(v, clause));
  }
  return false;
}

/**
 * Fake Job model recording every filter/pipeline it receives. `find()` returns a
 * chainable query whose terminal `lean()` resolves `docs`; `cast()` returns the
 * filter unchanged (the real one casts string ids to ObjectIds).
 */
function fakeJob({ count = 7, docs = [], groups = [], one = null, countFn } = {}) {
  const calls = { countDocuments: [], find: [], findOne: [], aggregate: [], limit: [] };
  const query = (filter, result) => {
    const q = {
      select: () => q,
      populate: () => q,
      sort: () => q,
      skip: () => q,
      limit: (n) => {
        calls.limit.push(n);
        return q;
      },
      lean: async () => result,
      cast: () => filter,
    };
    return q;
  };
  const Job = {
    countDocuments: async (filter) => {
      calls.countDocuments.push(filter);
      return countFn ? countFn(filter) : count;
    },
    find: (filter) => {
      calls.find.push(filter);
      return query(filter, docs);
    },
    findOne: (filter) => {
      calls.findOne.push(filter);
      return query(filter, one);
    },
    aggregate: async (pipeline) => {
      calls.aggregate.push(pipeline);
      return groups;
    },
  };
  return { Job, calls };
}

function ctxFor(Job) {
  return {
    user: USER,
    requestId: 'req-1',
    deps: { Job, resolveJobVisibilityFilter: async () => VIS },
  };
}

describe('count_jobs', () => {
  it('counts with the visibility clause ANDed in and echoes the applied filters', async () => {
    const { Job, calls } = fakeJob({ count: 12 });
    const out = await countJobs.execute({ filters: { jobType: 'Internship' } }, ctxFor(Job));
    assert.equal(out.total, 12);
    assert.equal(calls.countDocuments.length, 1);
    assert.ok(contains(calls.countDocuments[0], VIS), 'visibility clause missing');
    assert.ok(contains(calls.countDocuments[0], { status: 'Active', jobType: 'Internship' }));
    assert.deepEqual(out.filtersApplied, { jobType: 'Internship', status: 'Active' });
  });

  it('defaults status to Active when omitted, and keeps an explicit status', async () => {
    const { Job, calls } = fakeJob();
    await countJobs.execute({}, ctxFor(Job));
    assert.ok(contains(calls.countDocuments[0], { status: 'Active' }));

    const second = fakeJob();
    const out = await countJobs.execute({ filters: { status: 'all' } }, ctxFor(second.Job));
    assert.equal(contains(second.calls.countDocuments[0], { status: 'Active' }), false);
    assert.equal(out.filtersApplied.status, 'all');
  });

  it('turns search ["ml","ai"] into one $or of the two search clauses', async () => {
    const { Job, calls } = fakeJob();
    await countJobs.execute({ filters: { search: ['ml', 'ai'] } }, ctxFor(Job));
    const expected = { $or: [buildJobSearchClause('ml', true), buildJobSearchClause('ai', true)] };
    assert.ok(contains(calls.countDocuments[0], expected));
  });

  it('groupBy jobType builds $group on $jobType with visibility ANDed into $match', async () => {
    const { Job, calls } = fakeJob({
      groups: [
        { _id: 'Full-time', count: 9 },
        { _id: null, count: 2 },
        { _id: 'Internship', count: 4 },
      ],
    });
    const out = await countJobs.execute({ filters: {}, groupBy: 'jobType' }, ctxFor(Job));
    const [pipeline] = calls.aggregate;
    assert.ok(contains(pipeline[0].$match, VIS), 'visibility clause missing from $match');
    assert.ok(contains(pipeline[0].$match, { status: 'Active' }));
    assert.deepEqual(pipeline[1], { $group: { _id: '$jobType', count: { $sum: 1 } } });
    assert.equal(out.total, 15);
    assert.deepEqual(out.groups, [
      { value: 'Full-time', count: 9 },
      { value: 'Internship', count: 4 },
      { value: 'Not set', count: 2 },
    ]);
    assert.equal(out.groupBy, 'jobType');
  });

  it('maps groupBy company to organisation.name and caps groups at 25 with otherCount', async () => {
    const groups = Array.from({ length: 30 }, (_, i) => ({ _id: `Co${i}`, count: 30 - i }));
    const { Job, calls } = fakeJob({ groups });
    const out = await countJobs.execute({ groupBy: 'company' }, ctxFor(Job));
    assert.equal(calls.aggregate[0][1].$group._id, '$organisation.name');
    assert.equal(out.groups.length, 25);
    assert.equal(out.otherCount, 5 + 4 + 3 + 2 + 1);
    assert.equal(out.total, (30 * 31) / 2);
  });

  it('groupBy status covers every status unless a status was asked for', async () => {
    const { Job, calls } = fakeJob({ groups: [{ _id: 'Active', count: 3 }] });
    const out = await countJobs.execute({ groupBy: 'status' }, ctxFor(Job));
    assert.equal(contains(calls.aggregate[0][0].$match, { status: 'Active' }), false);
    assert.equal(out.filtersApplied.status, 'all');
  });

  it('groupBy origin uses computeJobOriginCounts (internal/external partition) under visibility', async () => {
    const { Job, calls } = fakeJob({
      countFn: (filter) => (contains(filter, { $nor: [MIRROR_EXTERNAL_OR] }) ? 5 : 3),
    });
    const out = await countJobs.execute({ groupBy: 'origin' }, ctxFor(Job));
    assert.equal(calls.aggregate.length, 0);
    assert.equal(calls.countDocuments.length, 2);
    for (const filter of calls.countDocuments) assert.ok(contains(filter, VIS));
    assert.equal(out.total, 8);
    assert.deepEqual(out.groups, [
      { value: 'internal', count: 5 },
      { value: 'external', count: 3 },
    ]);
  });

  it('renders a total fact when ungrouped, and a table (no count facts) when grouped', () => {
    const plain = countJobs.render({ total: 4, filtersApplied: { status: 'Active' } });
    assert.deepEqual(plain.blocks, []);
    assert.equal(plain.facts.counts[0].total, 4);
    assert.equal(plain.facts.counts[0].label, 'jobs');
    assert.equal(plain.facts.primary, plain.facts.counts[0]);

    const grouped = countJobs.render({
      total: 5,
      groupBy: 'jobType',
      groups: [{ value: 'Contract', count: 5 }],
      filtersApplied: { status: 'Active' },
    });
    assert.equal(grouped.blocks[0].type, 'table');
    assert.deepEqual(grouped.blocks[0].rows, [{ value: 'Contract', count: '5' }]);
    assert.deepEqual(grouped.facts.counts, []);
  });
});

describe('list_jobs', () => {
  const doc = {
    _id: JOB_ID,
    title: 'ML Engineer',
    status: 'Active',
    jobType: 'Full-time',
    organisation: { name: 'Acme' },
    jobDescription: 'long text',
  };

  it('lists with visibility ANDed in and returns compact rows', async () => {
    const { Job, calls } = fakeJob({ count: 1, docs: [doc] });
    const out = await listJobs.execute({ filters: { search: 'ml' }, limit: 10 }, ctxFor(Job));
    assert.equal(out.total, 1);
    assert.ok(contains(calls.countDocuments[0], VIS));
    assert.ok(contains(calls.find[0], VIS));
    assert.equal(out.jobs[0].jobId, JOB_ID);
    assert.equal(out.jobs[0].title, 'ML Engineer');
    assert.equal('jobDescription' in out.jobs[0], false);
    assert.deepEqual(calls.limit, [10]);
  });

  it('clamps limit at 50', async () => {
    const { Job, calls } = fakeJob({ docs: [] });
    await listJobs.execute({ limit: 500 }, ctxFor(Job));
    assert.deepEqual(calls.limit, [50]);
  });

  it('renders the jobs table and a total fact', () => {
    const out = listJobs.render({
      total: 1,
      filtersApplied: { status: 'Active' },
      jobs: [{ jobId: JOB_ID, title: 'ML Engineer', status: 'Active', organisation: { name: 'Acme' } }],
    });
    assert.equal(out.blocks[0].type, 'table');
    assert.equal(out.blocks[0].id, 'jobs');
    assert.equal(out.facts.counts[0].total, 1);
  });
});

describe('get_job', () => {
  it('fetches by id under visibility', async () => {
    const { Job, calls } = fakeJob({ one: { _id: JOB_ID, title: 'ML Engineer', status: 'Active' } });
    const out = await getJob.execute({ jobId: JOB_ID }, ctxFor(Job));
    assert.equal(out.job.jobId, JOB_ID);
    assert.ok(contains(calls.findOne[0], VIS));
  });

  it('returns notFound for an unknown or malformed id', async () => {
    const { Job, calls } = fakeJob({ one: null });
    assert.deepEqual(await getJob.execute({ jobId: JOB_ID }, ctxFor(Job)), { notFound: true });
    assert.deepEqual(await getJob.execute({ jobId: 'not-an-id' }, ctxFor(Job)), { notFound: true });
    assert.equal(calls.findOne.length, 1, 'malformed id must not reach Mongo');
  });

  it('resolves by title: unique, ambiguous, not found', async () => {
    const unique = fakeJob({ docs: [{ _id: JOB_ID, title: 'ML Engineer' }] });
    const u = await getJob.execute({ title: 'ML Engineer' }, ctxFor(unique.Job));
    assert.equal(u.job.title, 'ML Engineer');
    assert.ok(contains(unique.calls.find[0], VIS));

    const ambiguous = fakeJob({
      docs: [
        { _id: JOB_ID, title: 'Data Engineer' },
        { _id: '64b7f0c2a1b2c3d4e5f60719', title: 'Data Engineer II' },
      ],
    });
    const a = await getJob.execute({ title: 'Data Engineer' }, ctxFor(ambiguous.Job));
    assert.equal(a.matches.length, 2);

    const none = fakeJob({ docs: [] });
    assert.deepEqual(await getJob.execute({ title: 'Nope' }, ctxFor(none.Job)), { notFound: true });
  });

  it('falls back to the title when the id is not found', async () => {
    const { Job } = fakeJob({ one: null, docs: [{ _id: JOB_ID, title: 'ML Engineer' }] });
    const out = await getJob.execute({ jobId: JOB_ID, title: 'ML Engineer' }, ctxFor(Job));
    assert.equal(out.job.title, 'ML Engineer');
  });
});

describe('rank_jobs_by_salary', () => {
  it('delegates to executeRankQuery with visibility and returns compact rows', async () => {
    const { Job, calls } = fakeJob({
      count: 3,
      docs: [{ _id: JOB_ID, title: 'Staff ML', status: 'Active', salaryRange: { min: 100, max: 200 } }],
    });
    const out = await rankJobsBySalary.execute({ direction: 'asc', limit: 1 }, ctxFor(Job));
    assert.equal(out.total, 3);
    assert.equal(out.direction, 'asc');
    assert.equal(out.jobs[0].jobId, JOB_ID);
    assert.ok(contains(calls.find[0], VIS));
    assert.ok(contains(calls.find[0], { status: 'Active' }));
    assert.deepEqual(calls.limit, [1]);
  });

  it('clamps limit at 20', async () => {
    const { Job, calls } = fakeJob({ docs: [] });
    await rankJobsBySalary.execute({ limit: 99 }, ctxFor(Job));
    assert.deepEqual(calls.limit, [20]);
  });
});

describe('jobs domain module', () => {
  const tools = [countJobs, listJobs, getJob, rankJobsBySalary];

  it('every tool was built by defineTool with a JSON schema and jobs.read access', () => {
    for (const tool of tools) {
      assert.equal(tool.domain, 'jobs');
      assert.equal(tool.kind, 'read');
      assert.deepEqual(tool.access, { anyOf: ['jobs.read'] });
      assert.equal(tool.jsonSchema.type, 'object');
    }
    assert.deepEqual(
      tools.map((t) => t.name),
      ['count_jobs', 'list_jobs', 'get_job', 'rank_jobs_by_salary'],
    );
    assert.deepEqual(countJobs.jsonSchema.properties.groupBy.enum, [
      'jobType', 'status', 'experienceLevel', 'company', 'city', 'country', 'industry', 'origin',
    ]);
    assert.deepEqual(countJobs.jsonSchema.properties.filters.properties.search.anyOf.map((s) => s.type), [
      'string',
      'array',
    ]);
  });

  it('index.js default export matches the domain module shape', () => {
    assert.equal(jobsDomain.domain, 'jobs');
    assert.equal(typeof jobsDomain.instructions, 'string');
    assert.ok(jobsDomain.instructions.length > 0);
    assert.deepEqual(jobsDomain.tools, tools);
    assert.ok(allDomains.includes(jobsDomain));
  });
});
