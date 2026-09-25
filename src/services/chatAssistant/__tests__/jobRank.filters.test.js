import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJobRankingMongoFilter,
  parseJobFilters,
  andMongoFilters,
  scopeJobModel,
  verifyCompanyCandidate,
} from '../queryPlanner/entities/jobRank.js';

describe('buildJobRankingMongoFilter — location', () => {
  it('maps a location arg to a location filter clause (case-insensitive)', () => {
    const filter = buildJobRankingMongoFilter({ filters: { location: 'Nowhereville123' } });
    // Unresolvable free text falls back to a case-insensitive regex on `location`.
    assert.ok(filter.location, 'expected a location clause to be set');
    const clause = filter.location.$regex ? filter.location : filter.$and?.find((c) => c.location)?.location;
    assert.equal(clause.$options, 'i');
    assert.match('some job in NOWHEREVILLE123 office', new RegExp(clause.$regex, 'i'));
  });

  it('remote takes priority over an explicit location arg', () => {
    const filter = buildJobRankingMongoFilter({ filters: { remote: true, location: 'Bangalore' } });
    assert.match('Remote', filter.location.$regex);
  });
});

describe('buildJobRankingMongoFilter — experienceLevel', () => {
  it('matches case-insensitively on the exact experienceLevel string', () => {
    const filter = buildJobRankingMongoFilter({ filters: { experienceLevel: 'senior level' } });
    const re = new RegExp(filter.experienceLevel.$regex, filter.experienceLevel.$options);
    assert.ok(re.test('Senior Level'));
    assert.ok(!re.test('Mid Level'));
  });
});

describe('buildJobRankingMongoFilter — status/jobType case & hyphen normalization', () => {
  it('normalizes common status phrasing to the canonical enum value', () => {
    assert.equal(buildJobRankingMongoFilter({ filters: { status: 'active' } }).status, 'Active');
    assert.equal(buildJobRankingMongoFilter({ filters: { status: 'OPEN' } }).status, 'Active');
    assert.equal(buildJobRankingMongoFilter({ filters: { status: 'Filled' } }).status, 'Closed');
  });

  it('falls back to a case-insensitive exact match for an unrecognized status', () => {
    const filter = buildJobRankingMongoFilter({ filters: { status: 'active-ish' } });
    assert.equal(typeof filter.status, 'object');
    assert.equal(filter.status.$options, 'i');
  });

  it('normalizes jobType regardless of case, spacing or hyphens', () => {
    assert.equal(buildJobRankingMongoFilter({ filters: { jobType: 'full time' } }).jobType, 'Full-time');
    assert.equal(buildJobRankingMongoFilter({ filters: { jobType: 'FULLTIME' } }).jobType, 'Full-time');
    assert.equal(buildJobRankingMongoFilter({ filters: { jobType: 'Full-Time' } }).jobType, 'Full-time');
    assert.equal(buildJobRankingMongoFilter({ filters: { jobType: 'intern' } }).jobType, 'Internship');
  });
});

describe('parseJobFilters — active-default intent (only on open/active intent)', () => {
  it('does not default status to Active for a plain "how many jobs" question', () => {
    const filters = parseJobFilters('how many jobs are there');
    assert.equal(filters.status, undefined);
  });

  it('does not default status to Active for "list all jobs"', () => {
    const filters = parseJobFilters('list all jobs');
    assert.equal(filters.status, undefined);
  });

  it('still defaults to Active when the message expresses open/active intent', () => {
    assert.equal(parseJobFilters('show me active jobs').status, 'Active');
    assert.equal(parseJobFilters('what jobs are open right now').status, 'Active');
  });

  it('still honours an explicit non-active status word', () => {
    assert.equal(parseJobFilters('show me closed jobs').status, 'Closed');
    assert.equal(parseJobFilters('any draft jobs?').status, 'Draft');
  });

  it('carries forward a status already present in context filters', () => {
    const filters = parseJobFilters('show me more', { filters: { status: 'Closed' } });
    assert.equal(filters.status, 'Closed');
  });
});

describe('parseJobFilters — internal/external origin anchored to a job-noun', () => {
  it('does not set jobOrigin for "internally" or an unrelated use of "internal"', () => {
    assert.equal(parseJobFilters("let's discuss this internally").jobOrigin, undefined);
    assert.equal(parseJobFilters('schedule an internal review meeting').jobOrigin, undefined);
  });

  it('sets jobOrigin=internal for "internal jobs" / "internal openings" / "internal positions"', () => {
    assert.equal(parseJobFilters('show me internal jobs').jobOrigin, 'internal');
    assert.equal(parseJobFilters('any internal openings?').jobOrigin, 'internal');
    assert.equal(parseJobFilters('list internal positions').jobOrigin, 'internal');
  });

  it('sets jobOrigin=external for "external jobs" / "external listings"', () => {
    assert.equal(parseJobFilters('show me external jobs').jobOrigin, 'external');
    assert.equal(parseJobFilters('list external listings').jobOrigin, 'external');
  });
});

describe('andMongoFilters', () => {
  it('returns {} when both sides are empty', () => {
    assert.deepEqual(andMongoFilters({}, {}), {});
    assert.deepEqual(andMongoFilters(), {});
  });

  it('returns the non-empty side unchanged when the other is empty', () => {
    const a = { status: 'Active' };
    assert.deepEqual(andMongoFilters(a, {}), a);
    assert.deepEqual(andMongoFilters({}, a), a);
  });

  it('wraps both sides in $and when both are non-empty', () => {
    const a = { status: 'Active' };
    const b = { jobOrigin: 'external' };
    assert.deepEqual(andMongoFilters(a, b), { $and: [a, b] });
  });
});

describe('scopeJobModel', () => {
  it('returns the model unwrapped when the visibility filter is empty', () => {
    const JobModel = { find: () => {}, countDocuments: () => {} };
    assert.equal(scopeJobModel(JobModel, {}), JobModel);
    assert.equal(scopeJobModel(JobModel, null), JobModel);
  });

  it('ANDs the visibility filter into every find/countDocuments call', () => {
    const calls = { find: [], countDocuments: [] };
    const JobModel = {
      find: (f) => { calls.find.push(f); return 'find-result'; },
      countDocuments: (f) => { calls.countDocuments.push(f); return 'count-result'; },
    };
    const visibility = { $or: [{ createdBy: 'u1' }] };
    const scoped = scopeJobModel(JobModel, visibility);

    assert.equal(scoped.find({ status: 'Active' }), 'find-result');
    assert.deepEqual(calls.find[0], { $and: [{ status: 'Active' }, visibility] });

    assert.equal(scoped.countDocuments({}), 'count-result');
    assert.deepEqual(calls.countDocuments[0], visibility);
  });
});

describe('verifyCompanyCandidate — company regex over-capture guard', () => {
  const DISTINCT_ORG_NAMES = ['Aurora Tech Solutions', 'Northwind Traders'];
  const fakeJobModel = {
    exists: async (query) => {
      const re = new RegExp(query['organisation.name'].$regex, query['organisation.name'].$options);
      return DISTINCT_ORG_NAMES.some((name) => re.test(name));
    },
  };

  it('verifies a real company name (case-insensitive)', async () => {
    assert.equal(await verifyCompanyCandidate('aurora tech solutions', { Job: fakeJobModel }), true);
  });

  it('rejects a role-noun the regex over-captured ("jobs for React devs")', async () => {
    assert.equal(await verifyCompanyCandidate('React devs', { Job: fakeJobModel }), false);
  });

  it('rejects a location the regex over-captured ("at Bangalore")', async () => {
    assert.equal(await verifyCompanyCandidate('Bangalore', { Job: fakeJobModel }), false);
  });

  it('rejects an empty/missing candidate without querying', async () => {
    assert.equal(await verifyCompanyCandidate('', { Job: fakeJobModel }), false);
    assert.equal(await verifyCompanyCandidate(null, { Job: fakeJobModel }), false);
  });
});
