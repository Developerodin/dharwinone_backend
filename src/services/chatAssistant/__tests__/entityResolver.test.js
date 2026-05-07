// uat.dharwin.backend/src/services/chatAssistant/__tests__/entityResolver.test.js
//
// Covers the resolver's three return modes (unique / ambiguous / notFound),
// rename history, alias matching, orphan employees, and the disabled-user
// soft-delete guard.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserEntity } from '../entityResolver.js';

function matchesClause(d, clause) {
  for (const [field, expr] of Object.entries(clause)) {
    const value = d[field];
    if (expr?.$regex) {
      const rx = new RegExp(expr.$regex, expr.$options || '');
      if (Array.isArray(value)) return value.some((v) => rx.test(String(v)));
      return rx.test(String(value || ''));
    }
    if (value === expr) return true;
  }
  return false;
}

function mockModel(docs) {
  return {
    find: (filter) => {
      const status = filter.status;
      const ors = filter.$or || [];
      const matches = docs.filter((d) => {
        if (status && d.status !== status) return false;
        if (!ors.length) return true;
        return ors.some((clause) => matchesClause(d, clause));
      });
      const chain = {
        _docs: matches,
        select() { return chain; },
        limit(n) { chain._docs = chain._docs.slice(0, n); return chain; },
        lean: async () => chain._docs,
      };
      return chain;
    },
  };
}

const users = [
  { _id: 'u-maya',     status: 'active',
    name: 'Maya Iyer',     email: 'maya@example.test',       phoneNumber: '+91-90000-11111',
    previousNames: ['Maya Pichai'], aliases: ['MI'], roleIds: ['r-emp'] },
  { _id: 'u-john1',    status: 'active',
    name: 'John Smith',    email: 'john.smith@example.test', phoneNumber: '+91-90000-22222',
    previousNames: [], aliases: [], roleIds: ['r-emp'] },
  { _id: 'u-john2',    status: 'active',
    name: 'John Doe',      email: 'john.doe@example.test',   phoneNumber: '+91-90000-33333',
    previousNames: [], aliases: [], roleIds: ['r-emp'] },
  { _id: 'u-disabled', status: 'disabled',
    name: 'Disabled Bob',  email: 'bob@example.test',        phoneNumber: '+91-90000-44444',
    previousNames: [], aliases: [], roleIds: ['r-emp'] },
];

const employees = [
  { _id: 'e-maya',   owner: 'u-maya',   fullName: 'Maya Iyer',  employeeId: 'DBS101', designation: 'Engineer', department: 'Eng',  previousNames: [] },
  { _id: 'e-john1',  owner: 'u-john1',  fullName: 'John Smith', employeeId: 'DBS102', designation: 'PM',       department: 'Prod', previousNames: [] },
  { _id: 'e-john2',  owner: 'u-john2',  fullName: 'John Doe',   employeeId: 'DBS103', designation: 'Designer', department: 'Des',  previousNames: [] },
  { _id: 'e-orphan', owner: 'u-gone',   fullName: 'Ghost User', employeeId: 'DBS104', designation: null, department: null, previousNames: ['Ex Ghost'] },
];

const opts = () => ({ User: mockModel(users), Employee: mockModel(employees) });

describe('resolveUserEntity', () => {
  it('returns notFound for empty / null query', async () => {
    assert.equal((await resolveUserEntity('', opts())).kind, 'notFound');
    assert.equal((await resolveUserEntity(null, opts())).kind, 'notFound');
  });

  it('exact email scores 1.0 -> unique', async () => {
    const out = await resolveUserEntity('maya@example.test', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.userId, 'u-maya');
    assert.equal(out.match.score, 1);
  });

  it('exact employeeId scores 1.0 -> unique', async () => {
    const out = await resolveUserEntity('DBS103', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.employeeId, 'DBS103');
  });

  it('matches by previousNames after rename', async () => {
    const out = await resolveUserEntity('Maya Pichai', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.userId, 'u-maya');
    assert.equal(out.match.name, 'Maya Iyer');
  });

  it('two "John"s with the same surname-token return ambiguous', async () => {
    const out = await resolveUserEntity('John', opts());
    assert.equal(out.kind, 'ambiguous');
    assert.ok(out.matches.length >= 2);
  });

  it('"John Smith" disambiguates to one match', async () => {
    const out = await resolveUserEntity('John Smith', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.userId, 'u-john1');
  });

  it('skips disabled users (status !== active)', async () => {
    const out = await resolveUserEntity('Disabled Bob', opts());
    assert.equal(out.kind, 'notFound');
  });

  it('surfaces orphan employees with orphan: true', async () => {
    const out = await resolveUserEntity('Ghost', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.orphan, true);
    assert.equal(out.match.userId, null);
    assert.equal(out.match.empDocId, 'e-orphan');
  });

  it('orphan employee is findable by previous fullName', async () => {
    const out = await resolveUserEntity('Ex Ghost', opts());
    assert.equal(out.kind, 'unique');
    assert.equal(out.match.empDocId, 'e-orphan');
    assert.equal(out.match.orphan, true);
  });

  it('respects includeOrphans=false', async () => {
    const out = await resolveUserEntity('Ghost', { ...opts(), includeOrphans: false });
    assert.equal(out.kind, 'notFound');
  });
});
