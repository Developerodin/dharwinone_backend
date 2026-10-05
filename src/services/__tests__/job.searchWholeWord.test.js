/**
 * job.service.js's search-clause builder: the ATS Jobs page's plain-substring search
 * (via buildJobListFilter) and Sage's whole-word variant (buildJobSearchClause directly).
 *
 * buildJobListFilter no longer accepts a `searchWholeWord` filter key — nothing ever set
 * it (Sage gets whole-word matching from buildJobRankingMongoFilter, which calls
 * buildJobSearchClause itself), so it was dead code kept alive only by this test file. The
 * first test below instead guards that the Jobs page's own plain-substring search is
 * unaffected by that removal.
 *
 * `forCandidates: true` routes through buildJobListFilter's early-return branch, which
 * never reaches the DB-backed visibility check (userCanViewAllJobsForListing) — so the
 * first test stays a fast, DB-free unit test, matching
 * job.queryJobs.caseInsensitiveFilter.test.js's existing pattern for the same file.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

const emptyPage = { results: [], page: 1, limit: 12, totalPages: 0, totalResults: 0 };

let capturedFilter = null;
let queryJobs;
let buildJobSearchClause;
let buildJobToolbarSearchClause;

before(async () => {
  mock.module('../../models/job.model.js', {
    defaultExport: {
      paginate: async (filter) => {
        capturedFilter = filter;
        return emptyPage;
      },
      updateMany: async () => ({ modifiedCount: 0 }),
    },
  });
  mock.module('../../models/externalJob.model.js', {
    defaultExport: {
      exists: async () => null,
    },
  });
  mock.module('../../config/logger.js', {
    defaultExport: { warn: () => {}, info: () => {}, error: () => {} },
  });

  ({ queryJobs, buildJobSearchClause, buildJobToolbarSearchClause } = await import('../job.service.js'));
});

function getSearchClause(filter) {
  const isSearchOr = (items) =>
    Array.isArray(items) && items.some((c) => c.title || c['organisation.name'] || c.jobDescription);
  if (isSearchOr(filter.$or)) return filter.$or;
  if (filter.$and) {
    for (const clause of filter.$and) {
      if (isSearchOr(clause.$or)) return clause.$or;
    }
  }
  return null;
}

test('buildJobListFilter: search stays a plain substring (Jobs page behaviour, unchanged by dropping searchWholeWord)', async () => {
  capturedFilter = null;
  await queryJobs({ forCandidates: true, search: 'AI' }, {});
  const clause = getSearchClause(capturedFilter);
  assert.ok(Array.isArray(clause), 'expected a search $or clause');
  const titleField = clause[0].title;
  assert.ok(titleField instanceof RegExp);
  assert.equal(titleField.source, 'AI');
  assert.ok(titleField.test('Maintenance jobs'), 'substring "ai" inside another word should still match');
  assert.equal('searchWholeWord' in capturedFilter, false);
});

test('buildJobListFilter: searchFields=toolbar matches title/company/location only (ATS quick search)', async () => {
  capturedFilter = null;
  await queryJobs({ forCandidates: true, search: 'test', searchFields: 'toolbar' }, {});
  const clause = getSearchClause(capturedFilter);
  assert.ok(Array.isArray(clause));
  assert.equal(clause.length, 3);
  assert.ok(clause[0].title);
  assert.ok(clause[1]['organisation.name']);
  assert.ok(clause[2].location);
  assert.equal(clause.some((c) => c.jobDescription), false);
});

test('buildJobToolbarSearchClause: does not match "latest" via description-only substring', () => {
  const clause = buildJobToolbarSearchClause('test');
  const titleField = clause.$or[0].title;
  assert.ok(!titleField.test('Prompt Engineer'));
  assert.ok(titleField.test('Odin test job2'));
});

test('buildJobSearchClause: substring by default', () => {
  const clause = buildJobSearchClause('AI');
  const titleField = clause.$or[0].title;
  assert.ok(titleField instanceof RegExp);
  assert.equal(titleField.source, 'AI');
  assert.ok(titleField.test('Maintenance jobs'), 'substring "ai" inside another word should still match');
});

test('buildJobSearchClause: wholeWord=true anchors to word boundaries', () => {
  const clause = buildJobSearchClause('AI', true);
  const titleField = clause.$or[0].title;
  assert.ok(titleField instanceof RegExp);
  assert.equal(titleField.source, '(?<!\\w)AI(?!\\w)');
  assert.ok(!titleField.test('Maintenance jobs'), 'must not match "AI" inside "Maintenance"');
  assert.ok(titleField.test('AI Engineer'), 'must still match a real standalone word');
});

// Regression: \b requires a \w/\W transition, which "C++"/"C#" never produce next to
// whitespace or end-of-string (a "+"/"#" there is a \W-to-\W non-transition) — \b-based
// whole-word matching silently never matched these terms at all.
test('buildJobSearchClause: wholeWord=true still matches terms ending in a non-word character (C++, C#)', () => {
  let titleField = buildJobSearchClause('C++', true).$or[0].title;
  assert.ok(titleField.test('C++ Developer'), 'must match "C++" as a standalone word');
  assert.ok(titleField.test('Senior C++ Engineer'), 'must match "C++" in the middle of a title');

  titleField = buildJobSearchClause('C#', true).$or[0].title;
  assert.ok(titleField.test('C# Developer'), 'must match "C#" as a standalone word');
});
