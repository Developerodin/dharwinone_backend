import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJobRankingMongoFilter,
  andMongoFilters,
  scopeJobModel,
} from '../queryPlanner/entities/jobRank.js';
import { buildJobCountPhrase } from '../jobResult.js';

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

describe('buildJobCountPhrase / multi-topic search', () => {
  it('names city, company and search in the count reply', () => {
    assert.equal(buildJobCountPhrase({ status: 'Active', search: 'ai', city: 'Pune' }, 3), 'active ai jobs in Pune');
    assert.equal(buildJobCountPhrase({ status: 'Active', search: ['ml', 'ai'] }, 5), 'active ml or ai jobs');
  });

  it('several topics become one OR clause, each whole-word when short', () => {
    const filter = buildJobRankingMongoFilter({ filters: { search: ['ml', 'ai'] } });
    const or = filter.$or ?? filter.$and?.[0]?.$or;
    assert.equal(or.length, 2);
    assert.ok(or[1].$or[0].title.test('Applied AI Engineer'));
    assert.ok(!or[1].$or[0].title.test('Email Marketing'));
  });
});
