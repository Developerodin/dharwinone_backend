import { test } from 'node:test';
import assert from 'node:assert/strict';
import Task, { TASK_PRIORITIES } from '../task.model.js';

test('Task model exposes priority, sprintId, attachmentsCount', () => {
  const p = Task.schema.paths;
  assert.ok(p.priority, 'priority missing');
  assert.deepEqual([...p.priority.enumValues].sort(), [...TASK_PRIORITIES].sort());
  assert.equal(p.priority.defaultValue, 'medium');
  assert.ok(p.sprintId, 'sprintId missing');
  assert.equal(p.sprintId.options.ref, 'Sprint');
  assert.ok(p.attachmentsCount, 'attachmentsCount missing');
  assert.equal(p.attachmentsCount.defaultValue, 0);
});
