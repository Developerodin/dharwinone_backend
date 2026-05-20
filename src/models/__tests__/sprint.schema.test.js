import { test } from 'node:test';
import assert from 'node:assert/strict';
import Sprint, { SPRINT_STATUSES } from '../sprint.model.js';

test('Sprint model exposes required fields and statuses', () => {
  const p = Sprint.schema.paths;
  assert.ok(p.name?.isRequired, 'name should be required');
  assert.ok(p.projectId?.isRequired, 'projectId should be required');
  assert.equal(p.projectId.options.ref, 'Project');
  assert.ok(p.createdBy?.isRequired, 'createdBy should be required');
  assert.deepEqual([...p.status.enumValues].sort(), [...SPRINT_STATUSES].sort());
  assert.equal(p.status.defaultValue, 'planning');
});

test('Sprint uses physical collection "sprints"', () => {
  assert.equal(Sprint.collection.name, 'sprints');
});
