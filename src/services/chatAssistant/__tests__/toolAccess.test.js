import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_ACCESS, checkToolAccess } from '../toolAccess.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const svcSrc = fs.readFileSync(path.join(here, '..', '..', 'chatAssistant.service.js'), 'utf8');

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });
const notAdmin = { isAdmin: async () => false };
const admin = { isAdmin: async () => true };

describe('toolAccess', () => {
  it('every ROUTING_TOOLS name has a TOOL_ACCESS entry', () => {
    const start = svcSrc.indexOf('const ROUTING_TOOLS = [');
    const end = svcSrc.indexOf('\n];', start);
    const names = [...svcSrc.slice(start, end).matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(names.length >= 39, `parsed ${names.length} tool names`);
    const missing = names.filter((n) => !(n in TOOL_ACCESS));
    assert.deepEqual(missing, []);
  });

  it('denies unknown tools', async () => {
    const r = await checkToolAccess('fetch_everything', userWith('candidates.read'), notAdmin);
    assert.equal(r.ok, false);
  });

  it('denies fetch_candidates to a user with no candidate/employee read', async () => {
    const r = await checkToolAccess('fetch_candidates', userWith('tasks.read'), notAdmin);
    assert.equal(r.ok, false);
    assert.match(r.reason, /candidates/i);
  });

  it('allows fetch_candidates with candidates.read', async () => {
    const r = await checkToolAccess('fetch_candidates', userWith('candidates.read'), notAdmin);
    assert.equal(r.ok, true);
  });

  it('denies fetch_offers to a Candidate-role user', async () => {
    const r = await checkToolAccess('fetch_offers', userWith('jobs.read'), notAdmin);
    assert.equal(r.ok, false);
  });

  it('allows fetch_offers with pre-boarding.read (route parity)', async () => {
    const r = await checkToolAccess('fetch_offers', userWith('pre-boarding.read'), notAdmin);
    assert.equal(r.ok, true);
  });

  it('admin and platformSuperUser always pass', async () => {
    assert.equal((await checkToolAccess('fetch_roles', userWith(), admin)).ok, true);
    const su = { ...userWith(), platformSuperUser: true };
    assert.equal((await checkToolAccess('fetch_roles', su, notAdmin)).ok, true);
  });

  it('self-scoped tools pass with no permissions', async () => {
    assert.equal((await checkToolAccess('fetch_current_user', userWith(), notAdmin)).ok, true);
  });
});
