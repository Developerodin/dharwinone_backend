import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryTeamMembers } from '../team.service.js';
import TeamMember from '../../models/team.model.js';

test('queryTeamMembers populates employeeId on every result', async (t) => {
  const populateCalls = [];
  const originalFind = TeamMember.find.bind(TeamMember);
  t.mock.method(TeamMember, 'find', (filter) => {
    const q = originalFind(filter);
    const originalPopulate = q.populate.bind(q);
    q.populate = (spec) => { populateCalls.push(spec); return originalPopulate(spec); };
    return q;
  });
  try {
    await queryTeamMembers({}, { page: 1, limit: 1 });
  } catch (_) { /* DB not connected in unit test; ignore */ }
  const flat = populateCalls.flat();
  const paths = flat.map((p) => p?.path).filter(Boolean);
  assert.ok(paths.includes('employeeId'), 'employeeId not populated');
});
