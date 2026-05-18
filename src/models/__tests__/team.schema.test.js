import { test } from 'node:test';
import assert from 'node:assert/strict';
import Team from '../teamGroup.model.js';

test('Team model exposes teamLead, department, description, source', () => {
  const p = Team.schema.paths;
  assert.ok(p.teamLead && p.teamLead.options.ref === 'Employee', 'teamLead missing or wrong ref');
  assert.ok(p.department, 'department missing');
  assert.ok(p.description, 'description missing');
  assert.ok(p.source, 'source missing');
  assert.deepEqual(
    p.source.enumValues.sort(),
    ['ai-generated', 'excel-import', 'manual'].sort()
  );
});

test('Team uses physical collection "teamgroups" (no rename)', () => {
  assert.equal(Team.collection.name, 'teamgroups');
});
