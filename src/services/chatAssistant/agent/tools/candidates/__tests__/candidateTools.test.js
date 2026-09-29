import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countCandidates from '../countCandidates.tool.js';
import listCandidates from '../listCandidates.tool.js';
import matchCandidatesToJob from '../matchCandidatesToJob.tool.js';

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

describe('match_candidates_to_job', () => {
  const JOB = { _id: '64b7f0c2a1b2c3d4e5f60009', title: 'React Developer', skillTags: ['React'], skillRequirements: [{ name: 'Node' }] };

  function matchCtx({ job = JOB, hits = [], people = [], seen = {} } = {}) {
    return {
      user: SALES_AGENT,
      requestId: 'r',
      deps: {
        resolveJobVisibilityFilter: async () => ({ visible: true }),
        Job: { findOne: (f) => { seen.jobFilter = f; return { select: () => ({ lean: async () => job }) }; } },
        embedQuery: async (text) => { seen.embedText = text; return [0.1]; },
        pineconeQuery: async (ns, _v, topK) => { seen.ns = ns; seen.topK = topK; return hits; },
        applyEmployeeListScope: async (f) => ({ ...f, scopedFor: 'sa-1' }),
        buildEmployeeListMongoFilter: async (f) => { seen.apiFilter = f; return { mongoFilter: { roleScoped: true } }; },
        Employee: { find: (f) => { seen.peopleFilter = f; return { select: () => ({ lean: async () => people }) }; } },
      },
    };
  }

  it('ANDs the Jobs-page visibility into the job lookup and ranks only scoped Candidate profiles', async () => {
    const seen = {};
    const out = await matchCandidatesToJob.execute({ jobTitle: 'react', limit: 2 }, matchCtx({
      seen,
      hits: [{ metadata: { mongoId: 'u1' }, score: 0.9 }, { metadata: { mongoId: 'u2' }, score: 0.5 }],
      people: [
        { fullName: 'Low', owner: 'u2', skills: [] },
        { fullName: 'High', owner: 'u1', skills: [{ name: 'React' }, { name: 'Node' }] },
      ],
    }));
    assert.deepEqual(seen.jobFilter.$and[1], { visible: true });
    assert.equal(seen.ns, 'employees');
    assert.equal(seen.topK, 6);
    assert.equal(seen.apiFilter.ownerUserRole, 'candidate');
    assert.equal(seen.apiFilter.scopedFor, 'sa-1');
    assert.deepEqual(seen.peopleFilter.$and[0], { roleScoped: true });
    assert.deepEqual(seen.peopleFilter.$and[1].owner.$in, ['u1', 'u2']);
    assert.deepEqual(out.candidates.map((c) => c.name), ['High', 'Low']);
    assert.equal(out.candidates[0].matchPct, 97);
  });

  it('pool employees ranks current employees instead', async () => {
    const seen = {};
    await matchCandidatesToJob.execute({ jobId: JOB._id, pool: 'employees' }, matchCtx({
      seen, hits: [{ metadata: { mongoId: 'u1' }, score: 1 }],
    }));
    assert.equal(seen.apiFilter.ownerUserRole, 'employee');
    assert.equal(seen.apiFilter.employmentStatus, 'current');
  });

  it('a job the viewer cannot see is "not found", and no vector search runs', async () => {
    const seen = {};
    const out = await matchCandidatesToJob.execute({ jobTitle: 'secret' }, matchCtx({ seen, job: null }));
    assert.ok(out.error);
    assert.equal(seen.embedText, undefined);
  });

  it('a vector-search failure is a tool error, not a crash', async () => {
    const ctx = matchCtx();
    ctx.deps.pineconeQuery = async () => { throw new Error('down'); };
    const out = await matchCandidatesToJob.execute({ jobTitle: 'react' }, ctx);
    assert.match(out.error, /unavailable/);
  });
});
