import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import countEmployees from '../countEmployees.tool.js';
import listEmployees from '../listEmployees.tool.js';
import { EMPLOYEES_ACCESS, dayWindowBounds } from '../common.js';
import { employeeDocumentConditions, buildAdvancedFilter } from '../../../../../employee.service.js';

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

describe('document metadata filters', () => {
  const MANAGER = { id: 'm-1', _id: 'm-1', authContext: { permissions: new Set(['employees.read', 'employees.manage']) } };
  const PREBOARDING = { id: 'p-1', _id: 'p-1', authContext: { permissions: new Set(['employees.read', 'pre-boarding.read']) } };
  const SEP_2026 = { month: 'September', year: 2026 };

  it('builds a no-slip-for-that-month condition that matches the stored month forms', () => {
    const [cond] = employeeDocumentConditions({ missingSalarySlip: SEP_2026 });
    const { month, year } = cond.salarySlips.$not.$elemMatch;
    assert.equal(year, 2026);
    for (const m of ['September', 'sep', '9', '09']) assert.equal(month.test(m), true, m);
    for (const m of ['October', '19', 'Sept 2026']) assert.equal(month.test(m), false, m);
  });

  it('missingSalarySlip true means no slips at all; no document keys means no conditions', () => {
    assert.deepEqual(employeeDocumentConditions({ missingSalarySlip: true }), [{ 'salarySlips.0': { $exists: false } }]);
    assert.deepEqual(employeeDocumentConditions({ employmentType: 'Internship' }), []);
  });

  it('missingDocument Resume covers CV/Resume and the resume slot; approvedOnly needs status 1', () => {
    assert.deepEqual(employeeDocumentConditions({ missingDocument: { type: 'Resume', approvedOnly: true } }), [{
      $nor: [
        { documents: { $elemMatch: { type: { $in: ['Resume', 'CV/Resume'] }, status: 1 } } },
        { documents: { $elemMatch: { logicalSlot: 'resume', status: 1 } } },
      ],
    }]);
    assert.deepEqual(employeeDocumentConditions({ missingDocument: { type: 'PAN' } }), [
      { $nor: [{ documents: { $elemMatch: { type: 'PAN' } } }] },
    ]);
  });

  it('refuses the salary-slip filter without candidates.manage/employees.manage, before querying', async () => {
    let called = false;
    const ctx = ctxFor({ executeEmployeeQuery: async () => { called = true; return { success: true, total: 0 }; } });
    const out = await countEmployees.execute({ filters: { missingSalarySlip: SEP_2026 } }, ctx);
    assert.match(out.error, /salary slips/);
    assert.equal(called, false);
  });

  it('refuses the document filter without a document-view permission; pre-boarding.read is enough', async () => {
    const denied = await listEmployees.execute({ filters: { missingDocument: { type: 'Resume' } } }, ctxFor());
    assert.match(denied.error, /documents/);
    const allowed = await countEmployees.execute(
      { filters: { missingDocument: { type: 'Resume' } } },
      { ...ctxFor({ executeEmployeeQuery: async () => ({ success: true, total: 4, records: [] }) }), user: PREBOARDING },
    );
    assert.equal(allowed.total, 4);
  });

  it('keeps the Employee-role, current-employee default scope (no employmentStatus is forced)', async () => {
    let seen;
    const ctx = {
      ...ctxFor({ executeEmployeeQuery: async (q) => { seen = q; return { success: true, total: 3, records: [] }; } }),
      user: MANAGER,
    };
    await countEmployees.execute({ filters: { missingSalarySlip: SEP_2026 } }, ctx);
    assert.equal(seen.filters.ownerUserRole, 'employee');
    assert.deepEqual(seen.filters.missingSalarySlip, SEP_2026);
    assert.equal('employmentStatus' in seen.filters, false);

    let built;
    const groupCtx = {
      ...ctxFor({ buildEmployeeListMongoFilter: async (f) => { built = f; return { mongoFilter: {} }; } }),
      user: MANAGER,
    };
    await countEmployees.execute({ filters: { missingSalarySlip: true }, groupBy: 'department' }, groupCtx);
    assert.equal(built.missingSalarySlip, true);
    assert.equal('employmentStatus' in built, false);
  });

  it('list rows carry a missing label only when a document filter is used', async () => {
    const ctx = {
      ...ctxFor({ executeEmployeeQuery: async () => ({ success: true, total: 1, records: [{ _id: 'e1', fullName: 'Asha' }] }) }),
      user: MANAGER,
    };
    const out = await listEmployees.execute({ filters: { missingSalarySlip: SEP_2026 } }, ctx);
    assert.equal(out.records[0].missing, 'Salary slip Sep 2026');
    const block = listEmployees.render(out).blocks[0];
    assert.equal(block.columns.at(-1).key, 'missing');

    const plain = await listEmployees.execute({}, ctx);
    assert.equal('missing' in plain.records[0], false);
    assert.equal(listEmployees.render(plain).blocks[0].columns.some((c) => c.key === 'missing'), false);
  });
});

describe('joined / resigned windows', () => {
  it('maps a window to whole IST days and defaults employmentStatus to all', async () => {
    const calls = [];
    const ctx = ctxFor({ executeEmployeeQuery: async (q) => { calls.push(q); return { success: true, total: 3, records: [] }; } });
    await countEmployees.execute({ filters: { joinedBetween: { from: '2026-07-01', to: '2026-07-31' } } }, ctx);
    const f = calls[0].filters;
    assert.equal(f.joinedFrom, '2026-06-30T18:30:00.000Z'); // IST midnight of 07-01
    assert.equal(f.joinedTo, '2026-07-31T18:29:59.999Z'); // IST 23:59:59.999 of 07-31
    assert.equal(f.employmentStatus, 'all');
    assert.equal('joinedBetween' in f, false);
  });

  it('keeps an explicit employmentStatus', async () => {
    const calls = [];
    const ctx = ctxFor({ executeEmployeeQuery: async (q) => { calls.push(q); return { success: true, total: 1, records: [] }; } });
    await countEmployees.execute({ filters: { resignedBetween: { from: '2026-01-01' }, employmentStatus: 'resigned' } }, ctx);
    assert.equal(calls[0].filters.resignedFrom, '2025-12-31T18:30:00.000Z');
    assert.equal('resignedTo' in calls[0].filters, false);
    assert.equal(calls[0].filters.employmentStatus, 'resigned');
  });

  it('rejects a date that is not YYYY-MM-DD', async () => {
    await assert.rejects(
      countEmployees.execute({ filters: { joinedBetween: { from: 'July 2026' } } }, ctxFor()),
      /YYYY-MM-DD/,
    );
  });

  it('bounds days in IST, so "today" is the day the model was told, not the UTC day', () => {
    const { from, to } = dayWindowBounds({ from: '2026-09-29', to: '2026-09-29' });
    assert.equal(from, '2026-09-28T18:30:00.000Z');
    assert.equal(to, '2026-09-29T18:29:59.999Z');
    // 09:00 IST on 09-29 is 03:30Z — inside; 02:00 IST on 09-30 (20:30Z on 09-29) — outside.
    assert.ok(new Date('2026-09-29T03:30:00.000Z') >= new Date(from));
    assert.ok(new Date('2026-09-29T20:30:00.000Z') > new Date(to));
  });

  it('still catches date-only fields stored at UTC midnight on their own day', () => {
    const { from, to } = dayWindowBounds({ from: '2026-07-03', to: '2026-07-03' });
    const joiningDate = new Date('2026-07-03T00:00:00.000Z');
    assert.ok(joiningDate >= new Date(from) && joiningDate <= new Date(to));
    const dayBefore = new Date('2026-07-02T00:00:00.000Z');
    assert.ok(dayBefore < new Date(from));
  });

  it('rejects an impossible calendar day instead of rolling it over', async () => {
    assert.throws(() => dayWindowBounds({ from: '2026-02-30' }), /Invalid date '2026-02-30' — use YYYY-MM-DD/);
    assert.throws(() => dayWindowBounds({ to: '2026-13-01' }), /use YYYY-MM-DD/);
    assert.deepEqual(Object.keys(dayWindowBounds({ from: '2028-02-29' })), ['from']); // leap day is real
    await assert.rejects(
      countEmployees.execute({ filters: { joinedBetween: { from: '2026-02-30' } } }, ctxFor()),
      /YYYY-MM-DD/,
    );
  });

  it('rejects a reversed window instead of silently counting 0', async () => {
    assert.throws(() => dayWindowBounds({ from: '2026-07-31', to: '2026-07-01' }), /from is after to/);
    await assert.rejects(
      countEmployees.execute({ filters: { resignedBetween: { from: '2026-07-31', to: '2026-07-01' } } }, ctxFor()),
      /from is after to/,
    );
  });

  it('buildAdvancedFilter ANDs both windows without touching the employmentStatus resignDate key', () => {
    const m = buildAdvancedFilter({
      employmentStatus: 'resigned',
      joinedFrom: '2026-01-01T00:00:00.000Z',
      resignedTo: '2026-07-31T23:59:59.999Z',
    });
    assert.ok(m.resignDate.$lte instanceof Date); // employmentStatus clause intact
    assert.deepEqual(m.$and, [
      { joiningDate: { $ne: null, $gte: new Date('2026-01-01T00:00:00.000Z') } },
      { resignDate: { $ne: null, $lte: new Date('2026-07-31T23:59:59.999Z') } },
    ]);
  });

  it('list shows the Joined column only for a joined window', async () => {
    const ctx = ctxFor({
      executeEmployeeQuery: async () => ({ success: true, total: 1, records: [{ _id: 'e1', fullName: 'A', joiningDate: '2026-07-03' }] }),
    });
    const out = await listEmployees.execute({ filters: { joinedBetween: { from: '2026-07-01' } } }, ctx);
    const block = listEmployees.render(out).blocks[0];
    assert.ok(block.columns.some((c) => c.key === 'joiningDate'));
    assert.equal(block.rows[0].joiningDate, '2026-07-03');
    assert.equal(block.columns.some((c) => c.key === 'resignDate'), false);
  });
});
