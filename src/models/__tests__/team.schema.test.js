import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
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

test('Team defaults relatedPositions to []', () => {
  const t = new Team({ name: 'AI Team', createdBy: new mongoose.Types.ObjectId() });
  assert.deepEqual([...t.relatedPositions], []);
});
test('Team accepts a Position FK array', () => {
  const p1 = new mongoose.Types.ObjectId();
  const p2 = new mongoose.Types.ObjectId();
  const t = new Team({ name: 'FE Team', createdBy: new mongoose.Types.ObjectId(), relatedPositions: [p1, p2] });
  assert.deepEqual(t.relatedPositions.map(String), [p1.toString(), p2.toString()]);
});
test('Team keeps existing teamLead / department / description / source fields', () => {
  const t = new Team({ name: 'X', createdBy: new mongoose.Types.ObjectId(), department: 'Eng', description: 'd', source: 'manual' });
  assert.equal(t.department, 'Eng');
  assert.equal(t.description, 'd');
  assert.equal(t.source, 'manual');
});
test('Team model name stays TeamGroup, collection teamgroups', () => {
  assert.equal(Team.modelName, 'TeamGroup');
  assert.equal(Team.collection.collectionName, 'teamgroups');
});
