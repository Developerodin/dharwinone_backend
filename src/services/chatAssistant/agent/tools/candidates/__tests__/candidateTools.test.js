import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countCandidates from '../countCandidates.tool.js';
import listCandidates from '../listCandidates.tool.js';
import { matchesTurn } from '../index.js';

const SALES_AGENT = { id: 'sa-1', _id: 'sa-1', authContext: { permissions: new Set(['candidates.read']) } };

function ctxWith(executeEmployeeQuery) {
  return {
    user: SALES_AGENT,
    requestId: 'r',
    deps: {
      executeEmployeeQuery,
      applyEmployeeListScope: async (f) => f,
      buildEmployeeListMongoFilter: async (f) => ({ mongoFilter: f }),
      authorizeEmployeeQuery: () => ({ allowed: true }),
      Employee: {},
    },
  };
}

describe('count_candidates', () => {
  it('scopes to the Candidate role only — never employees (never aliased)', async () => {
    let seen;
    const out = await countCandidates.execute({}, ctxWith(async (q, user) => {
      seen = { q, user };
      return { success: true, total: 4, records: [] };
    }));
    assert.equal(out.total, 4);
    assert.equal(seen.q.filters.ownerUserRole, 'candidate');
    assert.equal(seen.q.filters.employmentStatus, 'all');
  });

  it('passes a Sales Agent viewer to the executor unchanged, so its pre-query scope applies (Review Focus 2)', async () => {
    let seenUser;
    await countCandidates.execute({}, ctxWith(async (q, user) => { seenUser = user; return { success: true, total: 0 }; }));
    assert.equal(seenUser, SALES_AGENT);
    assert.ok(seenUser.authContext.permissions.has('candidates.read'));
  });

  it('labels facts as candidates', () => {
    assert.equal(countCandidates.render({ total: 2 }).facts.counts[0].label, 'candidates');
  });
});

describe('list_candidates', () => {
  it('lists with the candidate scope and the skills filter', async () => {
    let seen;
    const out = await listCandidates.execute({ filters: { skills: ['react'] } }, ctxWith(async (q) => {
      seen = q;
      return { success: true, total: 1, page: 1, records: [{ _id: 'c1', fullName: 'Ravi' }] };
    }));
    assert.equal(seen.filters.ownerUserRole, 'candidate');
    assert.deepEqual(seen.filters.skills, ['react']);
    assert.equal(out.records[0].name, 'Ravi');
  });
});

describe('candidates matchesTurn', () => {
  it('matches candidate nouns only', () => {
    assert.equal(matchesTurn('how many candidates in Pune'), true);
    assert.equal(matchesTurn('how many employees'), false);
  });
});
