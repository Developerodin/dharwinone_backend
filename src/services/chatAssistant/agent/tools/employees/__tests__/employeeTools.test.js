import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countEmployees from '../countEmployees.tool.js';
import listEmployees from '../listEmployees.tool.js';
import { EMPLOYEES_ACCESS } from '../common.js';
import { matchesTurn } from '../index.js';

const VIEWER = { id: 'viewer-1', _id: 'viewer-1', authContext: { permissions: new Set(['employees.read']) } };

function ctxFor(overrides = {}) {
  return {
    user: VIEWER,
    requestId: 'req-1',
    deps: {
      executeEmployeeQuery: async () => ({ success: true, total: 0, records: [] }),
      applyEmployeeListScope: async (f) => f,
      buildEmployeeListMongoFilter: async (f) => ({ mongoFilter: { scoped: true, ...f } }),
      authorizeEmployeeQuery: () => ({ allowed: true, maskSalaryFields: true }),
      Employee: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
      ...overrides,
    },
  };
}

describe('count_employees', () => {
  it('scopes to the Employee role and passes the viewer through untouched', async () => {
    const calls = [];
    const ctx = ctxFor({
      executeEmployeeQuery: async (query, user) => { calls.push({ query, user }); return { success: true, total: 7, records: [] }; },
    });
    const out = await countEmployees.execute({ filters: { employmentType: 'Internship' } }, ctx);
    assert.equal(out.total, 7);
    assert.equal(calls[0].query.filters.ownerUserRole, 'employee');
    assert.equal(calls[0].query.filters.employmentType, 'Internship');
    assert.deepEqual(calls[0].query.operations, ['count']);
    assert.equal(calls[0].user, VIEWER);
  });

  it('returns the executor message as an error, never a silent 0', async () => {
    const ctx = ctxFor({ executeEmployeeQuery: async () => ({ success: false, error: 'FORBIDDEN', message: 'nope' }) });
    assert.deepEqual(await countEmployees.execute({}, ctx), { error: 'nope' });
  });

  it('groupBy employmentStatus uses the executor breakdown', async () => {
    const ctx = ctxFor({
      executeEmployeeQuery: async (q) => {
        assert.equal(q.filters.employmentStatus, 'all');
        return { success: true, total: 10, records: [], employmentBreakdown: { active: 8, resigned: 2, total: 10 } };
      },
    });
    const out = await countEmployees.execute({ groupBy: 'employmentStatus' }, ctx);
    assert.equal(out.total, 10);
    assert.deepEqual(out.groups, [{ value: 'current', count: 8 }, { value: 'resigned', count: 2 }]);
  });

  it('groupBy department groups the scoped rows and merges empty values into "Not set"', async () => {
    let seenFilter;
    const ctx = ctxFor({
      Employee: {
        find: (f) => { seenFilter = f; return { select: () => ({ lean: async () => [
          { department: 'Sales' }, { department: 'Sales' }, { department: '' }, { department: null },
        ] }) }; },
      },
    });
    const out = await countEmployees.execute({ groupBy: 'department' }, ctx);
    assert.equal(seenFilter.scoped, true);
    assert.equal(seenFilter.ownerUserRole, 'employee');
    assert.equal(out.total, 4);
    assert.deepEqual(out.groups, [{ value: 'Sales', count: 2 }, { value: 'Not set', count: 2 }]);
  });

  it('refuses a paid/unpaid breakdown when a salary-masked viewer narrows to one person (Review Focus 3)', async () => {
    const ctx = ctxFor({
      authorizeEmployeeQuery: (q) => (q.filters.search && q.filters.compensationType
        ? { allowed: false, code: 'FORBIDDEN', error: 'salary inference blocked' }
        : { allowed: true }),
      Employee: { find: () => { throw new Error('must not query'); } },
    });
    const out = await countEmployees.execute({ filters: { search: 'Priya' }, groupBy: 'compensationType' }, ctx);
    assert.deepEqual(out, { error: 'salary inference blocked' });
  });

  it('render: count facts for a plain count, a table and no facts for a breakdown', () => {
    assert.equal(countEmployees.render({ total: 3 }).facts.counts[0].total, 3);
    const grouped = countEmployees.render({ total: 3, groupBy: 'department', groups: [{ value: 'A', count: 3 }] });
    assert.equal(grouped.blocks[0].type, 'table');
    assert.deepEqual(grouped.facts.counts, []);
    assert.equal(countEmployees.render({ error: 'x' }), null);
  });

  it('uses the Employees page permissions', () => {
    assert.deepEqual(countEmployees.access, EMPLOYEES_ACCESS);
    assert.ok(EMPLOYEES_ACCESS.anyOf.includes('employees.read'));
  });
});

describe('list_employees', () => {
  it('caps the page size and maps only safe fields', async () => {
    let seen;
    const ctx = ctxFor({
      executeEmployeeQuery: async (q) => {
        seen = q;
        return {
          success: true, total: 1, page: 1, hasNextPage: false,
          records: [{ _id: 'e1', fullName: 'Asha', designation: 'Dev', salaryRange: { min: 1 } }],
        };
      },
    });
    const out = await listEmployees.execute({ limit: 500 }, ctx);
    assert.equal(seen.pagination.limit, 50);
    assert.equal(out.records[0].name, 'Asha');
    assert.equal('salaryRange' in out.records[0], false);
  });
});

describe('employees matchesTurn', () => {
  it('matches employee questions', () => {
    for (const t of ['how many employees do we have', 'unpaid interns by department', 'how many people work here', 'list resigned staff']) {
      assert.equal(matchesTurn(t), true, t);
    }
  });
  it('does not match candidate or job-only questions', () => {
    for (const t of ['how many candidates applied', 'show me react jobs']) {
      assert.equal(matchesTurn(t), false, t);
    }
  });
});
