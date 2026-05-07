import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmployeeFilter,
  buildKeysetCursorClause,
  clampPageSize,
  fetchPeople,
  normaliseEmploymentScope,
} from '../peopleFetcher.js';

describe('clampPageSize', () => {
  it('clamps below 10 to 10', () => assert.equal(clampPageSize(3), 10));
  it('clamps above 50 to 50', () => assert.equal(clampPageSize(200), 50));
  it('passes valid value through', () => assert.equal(clampPageSize(25), 25));
  it('defaults to 25 when missing', () => assert.equal(clampPageSize(undefined), 25));
  it('defaults to 25 when NaN', () => assert.equal(clampPageSize('abc'), 25));
});

describe('normaliseEmploymentScope', () => {
  it('maps active synonyms', () => {
    assert.equal(normaliseEmploymentScope('current'), 'active');
    assert.equal(normaliseEmploymentScope('ACTIVE'), 'active');
  });
  it('maps resigned synonyms', () => {
    for (const v of ['resigned', 'retired', 'former', 'past', 'ex', 'left']) {
      assert.equal(normaliseEmploymentScope(v), 'resigned');
    }
  });
  it('maps all/both', () => {
    assert.equal(normaliseEmploymentScope('all'), 'all');
    assert.equal(normaliseEmploymentScope('both'), 'all');
  });
  it('defaults to active on null/empty/unknown', () => {
    assert.equal(normaliseEmploymentScope(null), 'active');
    assert.equal(normaliseEmploymentScope(''), 'active');
    assert.equal(normaliseEmploymentScope('xyzzy'), 'active');
  });
});

describe('buildEmployeeFilter', () => {
  const ownerIds = ['o1', 'o2'];
  const today = new Date('2026-05-06T00:00:00Z');

  it('active scope: resignDate null OR future', () => {
    const f = buildEmployeeFilter({ ownerIds, scope: 'active', today });
    assert.deepEqual(f.owner, { $in: ownerIds });
    assert.ok(Array.isArray(f.$or));
    assert.equal(f.$or.length, 3);
  });

  it('resigned scope: resignDate not null AND <= today', () => {
    const f = buildEmployeeFilter({ ownerIds, scope: 'resigned', today });
    assert.deepEqual(f.resignDate, { $ne: null, $lte: today });
    assert.equal(f.$or, undefined);
  });

  it('all scope: no resignDate filter', () => {
    const f = buildEmployeeFilter({ ownerIds, scope: 'all', today });
    assert.equal(f.resignDate, undefined);
    assert.equal(f.$or, undefined);
  });

  it('omits owner clause when ownerIds is null (no role doc found)', () => {
    const f = buildEmployeeFilter({ ownerIds: null, scope: 'all', today });
    assert.equal(f.owner, undefined);
  });
});

describe('buildKeysetCursorClause', () => {
  it('returns {} when cursor is null', () => {
    assert.deepEqual(buildKeysetCursorClause(null), {});
  });

  it('returns $or comparing (employeeId, _id) when cursor present', () => {
    const cur = { lastEmployeeId: 'DBS50', lastId: 'abc' };
    const c = buildKeysetCursorClause(cur);
    assert.ok(Array.isArray(c.$or));
    assert.equal(c.$or.length, 2);
    assert.deepEqual(c.$or[0], { employeeId: { $gt: 'DBS50' } });
    assert.deepEqual(c.$or[1], { employeeId: 'DBS50', _id: { $gt: 'abc' } });
  });

  it('handles cursor with only lastId (User-collection paging)', () => {
    const c = buildKeysetCursorClause({ lastId: 'xyz' });
    assert.deepEqual(c, { _id: { $gt: 'xyz' } });
  });
});

// In-memory mock of a Mongoose Model — supports the methods peopleFetcher uses.
function mockModel(allDocs, predicate = () => true) {
  return {
    countDocuments: async (filter) => allDocs.filter((d) => predicate(d, filter)).length,
    find: (filter) => {
      const matched = allDocs.filter((d) => predicate(d, filter));
      const chain = {
        _docs: matched,
        select() { return chain; },
        populate() { return chain; },
        sort() { return chain; },
        limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
        lean: async () => chain._docs,
        distinct: async () => chain._docs.map((d) => d._id),
      };
      return chain;
    },
  };
}

describe('fetchPeople (Employee role)', () => {
  const today = new Date('2026-05-06T00:00:00Z');
  const past  = new Date('2025-01-01T00:00:00Z');

  const employees = Array.from({ length: 30 }, (_, i) => ({
    _id: `eid${String(i + 1).padStart(3, '0')}`,
    owner: `o${i + 1}`,
    fullName: `Person ${i + 1}`,
    email: `p${i + 1}@e.co`,
    phoneNumber: `100${i + 1}`,
    employeeId: `DBS${String(i + 1).padStart(3, '0')}`,
    designation: 'Engineer',
    department: 'Tech',
    resignDate: i < 25 ? null : past,
    isActive: i < 25,
  }));
  const users = employees.map((e) => ({
    _id: e.owner, name: e.fullName.toUpperCase(), email: e.email,
    phoneNumber: e.phoneNumber, status: 'active', roleIds: [],
  }));

  const Role = mockModel([{ _id: 'role-emp', name: 'Employee' }]);
  const User = mockModel(users);
  const Employee = mockModel(employees, (d, f) => {
    if (f?.resignDate?.$ne === null && f?.resignDate?.$lte) {
      return d.resignDate && d.resignDate <= f.resignDate.$lte;
    }
    if (f?.$or?.[0]?.resignDate === null) {
      return !d.resignDate || (f.$or[2]?.resignDate?.$gt && d.resignDate > f.$or[2].resignDate.$gt);
    }
    return true;
  });
  const Student = mockModel([]);

  it('returns 25 active employees + total + breakdown', async () => {
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today,
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 25);
    assert.equal(out.page.total, 25);
    assert.ok(out.breakdown);
    assert.equal(out.breakdown.active, 25);
    assert.equal(out.breakdown.resigned, 5);
  });

  it('returns 5 resigned employees with scope=resigned', async () => {
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'resigned',
      cursor: null,
      pageSize: 25,
      today,
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 5);
    assert.equal(out.page.total, 5);
  });

  it('orphan owner: synthesises identity from Employee, never N/A', async () => {
    const orphanEmp = mockModel([
      { _id: 'orphan-eid', owner: 'gone-user', fullName: 'Solo', email: 's@e.co', phoneNumber: '999', employeeId: 'DBS999', resignDate: null },
    ]);
    const emptyUser = mockModel([]);
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today,
      models: { Employee: orphanEmp, User: emptyUser, Role, Student },
    });
    assert.equal(out.records[0].name, 'Solo');
    assert.equal(out.records[0]._orphan, true);
    for (const v of Object.values(out.records[0])) {
      assert.notEqual(v, 'N/A');
    }
  });
});

describe('fetchPeople (Agent role)', () => {
  const agents = [
    { _id: 'a1', name: 'Agent One', email: 'a1@e.co', roleIds: ['role-agent'] },
    { _id: 'a2', name: 'Agent Two', email: 'a2@e.co', roleIds: ['role-agent'] },
  ];
  const employees = [{ _id: 'e1', fullName: 'Emp A' }];
  const Role = mockModel([{ _id: 'role-agent', name: 'Agent' }]);
  const User = mockModel(agents);
  const Employee = mockModel(employees);
  const Student = mockModel([]);

  it('returns ONLY agents — zero Employee leak', async () => {
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Agent',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 2);
    for (const r of out.records) assert.match(r.name, /^Agent /);
  });
});

describe('fetchPeople (Agent role) — legacy variant matching', () => {
  it('matches users assigned the lowercase "agent" Role doc', async () => {
    const agents = [
      { _id: 'a1', name: 'Agent Capital', email: 'ac@e.co', roleIds: ['role-agent-cap'] },
      { _id: 'a2', name: 'Agent Lower',   email: 'al@e.co', roleIds: ['role-agent-low'] },
    ];
    const roleDocs = [
      { _id: 'role-agent-cap', name: 'Agent', slug: 'agent', aliases: [], previousNames: [], status: 'active' },
      { _id: 'role-agent-low', name: 'agent', slug: undefined, aliases: [], previousNames: [], status: 'active' },
    ];
    const Role = {
      find: (filter) => ({
        lean: async () => {
          if (filter?.status === 'active') return roleDocs;
          if (filter?.name?.$in) {
            const regexes = filter.name.$in;
            return roleDocs.filter((d) => regexes.some((rx) => rx.test(d.name)));
          }
          if (filter?._id?.$in) {
            const ids = filter._id.$in.map(String);
            return roleDocs.filter((d) => ids.includes(String(d._id)));
          }
          return roleDocs;
        },
      }),
    };
    const User = {
      countDocuments: async (f) => {
        const ids = f?.roleIds?.$in?.map(String) || [];
        return agents.filter((a) => a.roleIds.some((r) => ids.includes(String(r)))).length;
      },
      find: (f) => {
        const ids = f?.roleIds?.$in?.map(String) || [];
        const matched = agents.filter((a) => a.roleIds.some((r) => ids.includes(String(r))));
        const chain = {
          _docs: matched,
          select() { return chain; },
          populate() { return chain; },
          sort() { return chain; },
          limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
          lean: async () => chain._docs,
          distinct: async () => chain._docs.map((d) => d._id),
        };
        return chain;
      },
    };
    const Employee = mockModel([]);
    const Student  = mockModel([]);
    const out = await fetchPeople({
      adminId: 'IGNORED',
      role: 'Agent',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 2);
    const names = out.records.map((r) => r.name).sort();
    assert.deepEqual(names, ['Agent Capital', 'Agent Lower']);
  });

  it('returns role_not_found when no Agent Role doc exists', async () => {
    const Role = mockModel(
      [{ _id: 'r-emp', name: 'Employee' }],
      (d, f) => {
        if (f?.name?.$in) return f.name.$in.some((rx) => rx.test(d.name));
        if (f?._id?.$in) return f._id.$in.map(String).includes(String(d._id));
        return true;
      }
    );
    const User = mockModel([]);
    const Employee = mockModel([]);
    const Student = mockModel([]);
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Agent',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.error, 'role_not_found');
    assert.deepEqual(out.records, []);
  });

  it('does NOT filter on adminId — returns Agents from any tenant', async () => {
    const agents = [
      { _id: 'a1', name: 'Agent Tenant1', email: 'a1@e.co', roleIds: ['role-agent'], adminId: 'tenantA' },
      { _id: 'a2', name: 'Agent Tenant2', email: 'a2@e.co', roleIds: ['role-agent'], adminId: 'tenantB' },
    ];
    const Role = mockModel([{ _id: 'role-agent', name: 'Agent' }]);
    const User = {
      countDocuments: async (f) => {
        assert.equal(f.adminId, undefined, 'adminId should NOT be in filter');
        const ids = f?.roleIds?.$in?.map(String) || [];
        return agents.filter((a) => a.roleIds.some((r) => ids.includes(String(r)))).length;
      },
      find: (f) => {
        assert.equal(f.adminId, undefined, 'adminId should NOT be in filter');
        const ids = f?.roleIds?.$in?.map(String) || [];
        const matched = agents.filter((a) => a.roleIds.some((r) => ids.includes(String(r))));
        const chain = {
          _docs: matched,
          select() { return chain; },
          populate() { return chain; },
          sort() { return chain; },
          limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
          lean: async () => chain._docs,
          distinct: async () => chain._docs.map((d) => d._id),
        };
        return chain;
      },
    };
    const Employee = mockModel([]);
    const Student  = mockModel([]);
    const out = await fetchPeople({
      adminId: 'tenantA',
      role: 'Agent',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 2);
  });
});

describe('fetchPeople (Student role)', () => {
  it('returns Students from any tenant — no adminId filter', async () => {
    const students = [
      { _id: 's1', name: 'Stu A', email: 'sa@e.co', adminId: 'tenantA' },
      { _id: 's2', name: 'Stu B', email: 'sb@e.co', adminId: 'tenantB' },
    ];
    const Role = mockModel([]);
    const User = mockModel([]);
    const Employee = mockModel([]);
    const Student = {
      countDocuments: async (f) => {
        assert.equal(f.adminId, undefined, 'adminId should NOT be in Student filter');
        return students.length;
      },
      find: (f) => {
        assert.equal(f.adminId, undefined, 'adminId should NOT be in Student filter');
        const chain = {
          _docs: students,
          select() { return chain; },
          populate() { return chain; },
          sort() { return chain; },
          limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
          lean: async () => chain._docs,
        };
        return chain;
      },
    };
    const out = await fetchPeople({
      adminId: 'tenantA',
      role: 'Student',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 2);
    for (const r of out.records) assert.deepEqual(r.roleNames, ['Student']);
  });
});

describe('fetchPeople error handling', () => {
  it('returns notFound when search yields zero records', async () => {
    const Role = mockModel([{ _id: 'role-emp', name: 'Employee' }]);
    const Employee = mockModel([]);
    const User = mockModel([]);
    const Student = mockModel([]);
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      search: 'Zaphod',
      today: new Date(),
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.notFound, true);
    assert.equal(out.searchedFor, 'Zaphod');
    assert.deepEqual(out.records, []);
  });

  it('Mongo throw propagates as { error: "fetch_failed" }', async () => {
    const throwing = {
      countDocuments: async () => { throw new Error('connection lost'); },
      find: () => { throw new Error('connection lost'); },
    };
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today: new Date(),
      models: { Employee: throwing, User: throwing, Role: throwing, Student: throwing },
    });
    assert.equal(out.error, 'fetch_failed');
    assert.deepEqual(out.records, []);
  });
});

describe('fetchPeople (Employee role) — multi-membership tagging', () => {
  it('dual-role Employee+Agent surfaces in Employee list tagged with both roles', async () => {
    const today = new Date('2026-05-06T00:00:00Z');
    const employees = [
      { _id: 'emp1', owner: 'u1', fullName: 'Dual Role',  email: 'dr@e.co', phoneNumber: '111', employeeId: 'DBS001', resignDate: null },
    ];
    const users = [
      { _id: 'u1', name: 'Dual Role', email: 'dr@e.co', phoneNumber: '111', status: 'active', roleIds: ['role-emp', 'role-agent'] },
    ];
    const roleDocs = [
      { _id: 'role-emp',   name: 'Employee' },
      { _id: 'role-agent', name: 'Agent' },
    ];
    const Role = {
      find: (filter) => ({
        lean: async () => {
          if (filter?.name?.$in) {
            const regexes = filter.name.$in;
            return roleDocs.filter((d) => regexes.some((rx) => rx.test(d.name)));
          }
          if (filter?._id?.$in) {
            const ids = filter._id.$in.map(String);
            return roleDocs.filter((d) => ids.includes(String(d._id)));
          }
          return roleDocs;
        },
      }),
    };
    const User = {
      countDocuments: async () => users.length,
      find: () => {
        const chain = {
          _docs: users,
          select() { return chain; },
          populate() { return chain; },
          sort() { return chain; },
          limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
          lean: async () => chain._docs,
          distinct: async () => chain._docs.map((d) => d._id),
        };
        return chain;
      },
    };
    const Employee = mockModel(employees);
    const Student  = mockModel([]);
    const out = await fetchPeople({
      adminId: 'admin1',
      role: 'Employee',
      employmentScope: 'active',
      cursor: null,
      pageSize: 25,
      today,
      models: { Employee, User, Role, Student },
    });
    assert.equal(out.records.length, 1);
    assert.ok(Array.isArray(out.records[0].roleNames), 'roleNames must be an array');
    assert.deepEqual(out.records[0].roleNames.sort(), ['Agent', 'Employee']);
    assert.ok(Array.isArray(out.records[0].role), 'role must also be an array (used by listingRenderer)');
    assert.deepEqual(out.records[0].role.sort(), ['Agent', 'Employee']);
  });
});
