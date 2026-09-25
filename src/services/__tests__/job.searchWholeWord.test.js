/**
 * buildJobListFilter's internal-only `searchWholeWord` flag (job.service.js).
 *
 * Sage sets this for short (<=3 char) topic words ("AI"/"UI"/"QA") so "how many AI jobs"
 * doesn't count jobs whose title/description merely contains "ai" as a substring (e.g.
 * "Maintenance Engineer"). The Jobs page itself never sends this key, so its own search
 * behaviour (plain substring) must stay byte-identical — the first test below guards that.
 *
 * `forCandidates: true` routes through buildJobListFilter's early-return branch, which
 * never reaches the DB-backed visibility check (userCanViewAllJobsForListing) — so this
 * stays a fast, DB-free unit test, matching job.queryJobs.caseInsensitiveFilter.test.js's
 * existing pattern for the same file.
 */
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';

const emptyPage = { results: [], page: 1, limit: 12, totalPages: 0, totalResults: 0 };

let capturedFilter = null;
let queryJobs;

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

  ({ queryJobs } = await import('../job.service.js'));
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

async function queryCandidateJobs(filter) {
  capturedFilter = null;
  return queryJobs({ ...filter, forCandidates: true }, {});
}

test('buildJobListFilter: search is a plain substring by default (Jobs page behaviour, unchanged)', async () => {
  await queryCandidateJobs({ search: 'AI' });
  const clause = getSearchClause(capturedFilter);
  assert.ok(Array.isArray(clause), 'expected a search $or clause');
  const titleField = clause[0].title;
  assert.ok(titleField instanceof RegExp);
  assert.equal(titleField.source, 'AI');
  assert.ok(titleField.test('Maintenance jobs'), 'substring "ai" inside another word should still match');
  assert.equal('searchWholeWord' in capturedFilter, false);
});

test('buildJobListFilter: searchWholeWord=true anchors the search to word boundaries', async () => {
  await queryCandidateJobs({ search: 'AI', searchWholeWord: true });
  const clause = getSearchClause(capturedFilter);
  assert.ok(Array.isArray(clause), 'expected a search $or clause');
  const titleField = clause[0].title;
  assert.ok(titleField instanceof RegExp);
  assert.equal(titleField.source, '(?<!\\w)AI(?!\\w)');
  assert.ok(!titleField.test('Maintenance jobs'), 'must not match "AI" inside "Maintenance"');
  assert.ok(titleField.test('AI Engineer'), 'must still match a real standalone word');
  assert.equal('searchWholeWord' in capturedFilter, false, 'internal-only key must never reach the Mongo filter');
});

// Regression: \b requires a \w/\W transition, which "C++"/"C#" never produce next to
// whitespace or end-of-string (a "+"/"#" there is a \W-to-\W non-transition) — \b-based
// whole-word matching silently never matched these terms at all.
test('buildJobListFilter: searchWholeWord=true still matches terms ending in a non-word character (C++, C#)', async () => {
  await queryCandidateJobs({ search: 'C++', searchWholeWord: true });
  let clause = getSearchClause(capturedFilter);
  let titleField = clause[0].title;
  assert.ok(titleField.test('C++ Developer'), 'must match "C++" as a standalone word');
  assert.ok(titleField.test('Senior C++ Engineer'), 'must match "C++" in the middle of a title');

  await queryCandidateJobs({ search: 'C#', searchWholeWord: true });
  clause = getSearchClause(capturedFilter);
  titleField = clause[0].title;
  assert.ok(titleField.test('C# Developer'), 'must match "C#" as a standalone word');
});
