import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJobRankingMongoFilter,
  parseJobFilters,
  andMongoFilters,
  scopeJobModel,
  verifyCompanyCandidate,
} from '../queryPlanner/entities/jobRank.js';
import {
  planJobFilterQuery,
  extractJobTopicKeyword,
  looksLikeJobFilterQuery,
  parseJobFollowUp,
} from '../queryPlanner/entities/jobFilter.js';
import { buildJobCountPhrase } from '../jobResult.js';
import { renderTitleAmbiguity } from '../conversationPolicy/renderFacts.js';
import { matchTitleSelection } from '../conversationalEntity/preRouter.js';

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

describe('planJobFilterQuery — topic keyword extraction', () => {
  it('extracts a bare topic word into filters.search ("how many ai jobs do we have")', () => {
    const plan = planJobFilterQuery({ userMessage: 'how many ai jobs do we have' });
    assert.equal(plan.filters.search, 'ai');
    // Matches the Jobs page's own default — no status word was said, so it's Active, not
    // every status (see "planJobFilterQuery — status defaults to Active" below).
    assert.equal(plan.filters.status, 'Active');
  });

  it('strips already-parsed modifiers and keeps the topic\'s own casing', () => {
    const plan = planJobFilterQuery({ userMessage: 'how many active remote AI jobs' });
    assert.equal(plan.filters.status, 'Active');
    assert.equal(plan.filters.remote, true);
    assert.equal(plan.filters.search, 'AI');
  });

  it('sets no search for a plain "how many jobs" (still defaults status to Active)', () => {
    const plan = planJobFilterQuery({ userMessage: 'how many jobs' });
    assert.equal(plan.filters.search, undefined);
    assert.equal(plan.filters.status, 'Active');
  });

  it('extracts a multi-word topic ("number of react developer positions")', () => {
    const plan = planJobFilterQuery({ userMessage: 'number of react developer positions' });
    assert.equal(plan.filters.search, 'react developer');
  });

  it('extracts a topic after "list" through the full pipeline ("list all sales jobs")', () => {
    const plan = planJobFilterQuery({ userMessage: 'list all sales jobs' });
    assert.equal(plan.filters.search, 'sales');
  });

  // extractJobTopicKeyword itself, independent of the outer looksLikeJobFilterQuery gate
  // (see the "roles as a job noun" describe block below for the full-pipeline versions of
  // these same two examples).
  it('extracts the topic word itself, independent of the outer gate', () => {
    assert.equal(extractJobTopicKeyword('list sales openings'), 'sales');
    assert.equal(extractJobTopicKeyword('any data science roles'), 'data science');
  });
});

describe('planJobFilterQuery — fresh question vs. follow-up context inheritance', () => {
  it('a fresh (non-follow-up) question does not inherit a prior status filter (defaults to Active instead)', () => {
    // Closed (not Active) as the ctx marker so this can tell "ignored ctx and defaulted"
    // apart from "ignored ctx and defaulting happened to land on the same value".
    const ctx = { filters: { status: 'Closed' }, intent: 'count' };
    const plan = planJobFilterQuery({ userMessage: 'how many external jobs are there', jobQueryContext: ctx });
    assert.equal(plan.filters.status, 'Active');
    assert.equal(plan.filters.jobOrigin, 'external');
  });

  it('an explicit follow-up still inherits the prior context filter', () => {
    const ctx = { filters: { status: 'Closed' }, intent: 'count' };
    const plan = planJobFilterQuery({ userMessage: 'and external?', jobQueryContext: ctx });
    assert.equal(plan.filters.status, 'Closed');
    assert.equal(plan.filters.jobOrigin, 'external');
  });

  // Regression: a new topic named in the follow-up itself must replace the inherited one,
  // not just add to it — "how many ai jobs" then "what about react jobs?" means react jobs,
  // not "ai jobs that are also react".
  it('a new topic in the follow-up replaces the inherited search', () => {
    const ctx = { filters: { search: 'ai', status: 'Active' }, intent: 'count' };
    const plan = planJobFilterQuery({ userMessage: 'what about react jobs?', jobQueryContext: ctx });
    assert.equal(plan.filters.search, 'react');
  });

  // Regression: the strong "every status" phrases override the inherited status in a
  // follow-up too, not just on a fresh question.
  it('an unambiguous "every status" phrase in the follow-up overrides the inherited status', () => {
    const ctx = { filters: { status: 'Active' }, intent: 'count' };
    const plan = planJobFilterQuery({ userMessage: 'and including closed?', jobQueryContext: ctx });
    assert.equal(plan.filters.status, 'all');
  });
});

describe('planJobFilterQuery — status defaults to Active (matches the Jobs page default)', () => {
  it('defaults to Active when no status word is said', () => {
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs' }).filters.status, 'Active');
    assert.equal(planJobFilterQuery({ userMessage: 'how many ai jobs' }).filters.status, 'Active');
  });

  it('still honours an explicit non-active status word instead of defaulting', () => {
    assert.equal(planJobFilterQuery({ userMessage: 'how many closed jobs' }).filters.status, 'Closed');
  });

  it('maps to status "all" only for an unambiguous "every status" phrase', () => {
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs across all statuses' }).filters.status, 'all');
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs, any status' }).filters.status, 'all');
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs including closed' }).filters.status, 'all');
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs have we ever posted' }).filters.status, 'all');
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs, every status' }).filters.status, 'all');
  });

  // Regression: a bare "all" is a generic quantifier ("every one"), not a request for every
  // status — it must not be confused with "all statuses"/"every status"/etc.
  it('a bare "all" does NOT switch to every status — stays Active', () => {
    assert.equal(planJobFilterQuery({ userMessage: 'show me all jobs' }).filters.status, 'Active');
    assert.equal(planJobFilterQuery({ userMessage: 'list all AI jobs' }).filters.status, 'Active');
    assert.equal(planJobFilterQuery({ userMessage: 'list all jobs' }).filters.status, 'Active');
  });

  it('invariant: the AI-jobs filter is the "how many jobs" filter plus a search clause, so its count can only be <=', () => {
    const jobsPlan = planJobFilterQuery({ userMessage: 'how many jobs' });
    const aiPlan = planJobFilterQuery({ userMessage: 'how many ai jobs' });
    assert.equal(jobsPlan.filters.status, 'Active');
    assert.equal(aiPlan.filters.status, 'Active');
    assert.equal(jobsPlan.filters.search, undefined);
    assert.equal(aiPlan.filters.search, 'ai');

    const jobsMongo = buildJobRankingMongoFilter(jobsPlan);
    const aiMongo = buildJobRankingMongoFilter(aiPlan);
    // Same base status restriction, plus an additional AND'd search clause — a strict
    // narrowing of jobsMongo, so counting against aiMongo can never exceed jobsMongo's count.
    assert.equal(jobsMongo.status, 'Active');
    assert.ok(aiMongo.$and, 'the AI-jobs filter must AND the base status with the extra search clause');
    assert.deepEqual(aiMongo.$and[0], jobsMongo, 'the base clause inside $and must be exactly the unfiltered plan\'s Mongo filter');
  });
});

describe('extractJobTopicKeyword — "jobs of/for/with/related to X" and "X related jobs"', () => {
  it('extracts the topic from "jobs of X" ("how many jobs of react do we have")', () => {
    assert.equal(extractJobTopicKeyword('how many jobs of react do we have'), 'react');
  });

  it('extracts the topic from "jobs for X"', () => {
    assert.equal(extractJobTopicKeyword('how many jobs for react do we have'), 'react');
  });

  it('extracts the topic from "jobs related to X"', () => {
    assert.equal(extractJobTopicKeyword('how many jobs related to react do we have'), 'react');
  });

  it('extracts the topic from "X related jobs"', () => {
    assert.equal(extractJobTopicKeyword('how many react related jobs do we have'), 'react');
  });

  it('"jobs in <city>" is not captured as a topic — location parsing owns that', () => {
    assert.equal(extractJobTopicKeyword('how many jobs in Bangalore'), null);
    const filters = parseJobFilters('how many jobs in Bangalore');
    assert.equal(filters.city, 'Bangalore');
  });

  // Regression: "jobs for react are there" must not capture "react are there" — the
  // capture stops at a stop word like "are"/"is"/"there" instead of running to the noun's
  // trailing punctuation or the end of the sentence.
  it('stops the capture at a trailing stop word ("are"/"is"/"there")', () => {
    assert.equal(extractJobTopicKeyword('how many jobs for react are there'), 'react');
  });

  // Regression: "with X" is dropped entirely — parseSkillFilter already owns "jobs with X"
  // (skill) and parseExperienceYears already owns "N-M years" (experience); treating "with"
  // as a topic preposition too double-counted the same phrase as a search term.
  it('does not extract a topic from "jobs with X" — that is a skill/experience filter, not a topic', () => {
    assert.equal(extractJobTopicKeyword('how many jobs with react skills do we have'), null);
    assert.equal(extractJobTopicKeyword('how many jobs with 3-5 years experience'), null);
  });
});

describe('looksLikeJobFilterQuery / planJobFilterQuery — "roles" as a job noun, and its exclusions', () => {
  it('routes "how many AI roles", "list sales openings", "show me react jobs" and "any data science roles" deterministically, search set, status Active', () => {
    const cases = [
      ['how many AI roles', 'AI'],
      ['list sales openings', 'sales'],
      ['show me react jobs', 'react'],
      ['any data science roles', 'data science'],
    ];
    for (const [message, expectedSearch] of cases) {
      const plan = planJobFilterQuery({ userMessage: message });
      assert.ok(plan, `expected ${JSON.stringify(message)} to route deterministically`);
      assert.equal(plan.filters.search, expectedSearch, `search for ${JSON.stringify(message)}`);
      assert.equal(plan.filters.status, 'Active', `status for ${JSON.stringify(message)}`);
    }
  });

  // Regression: "roles" is also the fetch_roles (RBAC) tool's own vocabulary — a job query
  // must not steal "list roles and permissions" or "user/system/admin roles" just because
  // they contain the word "roles".
  it('does not steal RBAC-flavored "roles" questions from the fetch_roles tool', () => {
    const nonJobQueries = [
      'list roles and permissions',
      'list user roles',
      'show system roles',
      'list admin roles',
    ];
    for (const message of nonJobQueries) {
      assert.equal(looksLikeJobFilterQuery(message), false, `should not route: ${JSON.stringify(message)}`);
      assert.equal(planJobFilterQuery({ userMessage: message }), null, `should not plan: ${JSON.stringify(message)}`);
    }
  });
});

describe('verifyCompanyFilter — company vs city from the same "at X" words', () => {
  it('keeps a real company and drops the duplicate city', async () => {
    const { verifyCompanyFilter } = await import('../entityQuery/runJobEntityQuery.js');
    const plan = { filters: { company: 'Acme', city: 'Acme', status: 'Active' } };
    await verifyCompanyFilter(plan, { verifyCompanyCandidate: async () => true });
    assert.deepEqual(plan.filters, { company: 'Acme', status: 'Active' });
  });

  it('drops an unverified company and keeps the city', async () => {
    const { verifyCompanyFilter } = await import('../entityQuery/runJobEntityQuery.js');
    const plan = { filters: { company: 'Bangalore', city: 'Bangalore', status: 'Active' } };
    await verifyCompanyFilter(plan, { verifyCompanyCandidate: async () => false });
    assert.deepEqual(plan.filters, { city: 'Bangalore', status: 'Active' });
  });
});

describe('"jobs in X" — place or topic', () => {
  it('cuts trailing question filler from the city capture', () => {
    assert.equal(planJobFilterQuery({ userMessage: 'how many jobs in ai do we have' }).filters.city, 'ai');
  });

  it('turns an "in X" that matches no job location into the search term', async () => {
    const { verifyCityFilter } = await import('../entityQuery/runJobEntityQuery.js');
    const plan = { filters: { city: 'ai', status: 'Active' } };
    await verifyCityFilter(plan, { verifyCityCandidate: async () => false });
    assert.deepEqual(plan.filters, { search: 'ai', status: 'Active' });
  });

  it('keeps a real place as the city', async () => {
    const { verifyCityFilter } = await import('../entityQuery/runJobEntityQuery.js');
    const plan = { filters: { city: 'pune', search: 'ai', status: 'Active' } };
    await verifyCityFilter(plan, { verifyCityCandidate: async () => true });
    assert.deepEqual(plan.filters, { city: 'pune', search: 'ai', status: 'Active' });
  });

  it('checks the place as a whole word so "ai" is not "Mumbai"', async () => {
    const { verifyCityCandidate } = await import('../queryPlanner/entities/jobRank.js');
    let seen;
    const Job = { exists: async (q) => { seen = q.location.$regex; return null; } };
    assert.equal(await verifyCityCandidate('ai', { Job }), false);
    assert.ok(!new RegExp(seen, 'i').test('Mumbai, Maharashtra'));
    assert.ok(new RegExp(seen, 'i').test('AI Park, Pune'));
  });

  it('names city, company and search in the count reply', async () => {
    const { buildJobCountPhrase } = await import('../jobResult.js');
    assert.equal(buildJobCountPhrase({ status: 'Active', search: 'ai', city: 'Pune' }, 3), 'active ai jobs in Pune');
  });
});

describe('job topics — several topics, bare follow-ups, title prompt totals', () => {
  const ctx = { filters: { search: 'ml', status: 'Active' }, intent: 'count' };

  it('"ml and ai jobs" searches both topics', () => {
    const plan = planJobFilterQuery({ userMessage: 'how many ml and ai jobs do we have today' });
    assert.deepEqual(plan.filters.search, ['ml', 'ai']);
    assert.equal(buildJobCountPhrase(plan.filters, 5), 'active ml or ai jobs');
  });

  it('several topics become one OR clause, each whole-word when short', () => {
    const filter = buildJobRankingMongoFilter({ filters: { search: ['ml', 'ai'] } });
    const or = filter.$or ?? filter.$and?.[0]?.$or;
    assert.equal(or.length, 2);
    assert.ok(or[1].$or[0].title.test('Applied AI Engineer'));
    assert.ok(!or[1].$or[0].title.test('Email Marketing'));
  });

  it('"what about ai" after a job count swaps the topic', () => {
    assert.equal(parseJobFollowUp('what about ai', ctx).filters.search, 'ai');
    assert.equal(parseJobFollowUp('ok what about next', ctx).filters.search, 'next');
    assert.deepEqual(parseJobFollowUp('how about python and go', ctx).filters.search, ['python', 'go']);
  });

  it('modifier-only follow-ups keep the inherited topic', () => {
    assert.equal(parseJobFollowUp('and remote?', ctx).filters.search, 'ml');
    assert.equal(parseJobFollowUp('what about external', ctx).filters.search, 'ml');
    const closed = parseJobFollowUp('what about closed ones', ctx).filters;
    assert.equal(closed.search, 'ml');
    assert.equal(closed.status, 'Closed');
  });

  it('"sort by salary" is not mistaken for a "so" opener', () => {
    assert.equal(parseJobFollowUp('sort by salary', ctx), null);
  });

  it('title prompt reports real totals, not the capped match list', () => {
    const text = renderTitleAmbiguity({
      query: 'ai',
      jobMatches: new Array(10).fill({ title: 'AI' }),
      employeeMatches: [{ name: 'A' }],
      jobTotal: 80,
      employeeTotal: 8,
    });
    assert.match(text, /80 active jobs/);
    assert.match(text, /8 employees/);
  });

  it('a bare "job" pick asks for every matching job', () => {
    const pending = { jobMatches: [{ jobId: 'a' }, { jobId: 'b' }], employeeMatches: [{}] };
    assert.equal(matchTitleSelection('job', pending).allJobs, true);
    assert.equal(matchTitleSelection('jobs', pending).allJobs, true);
    assert.equal(matchTitleSelection('first job', pending).allJobs, undefined);
  });
});
