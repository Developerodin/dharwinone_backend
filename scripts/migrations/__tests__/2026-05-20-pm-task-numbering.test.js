import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberTasksForProject } from '../2026-05-20-pm-task-numbering.js';

test('numberTasksForProject assigns contiguous seq ordered by order then createdAt', () => {
  const tasks = [
    { _id: 'b', order: 2, createdAt: new Date('2026-01-02') },
    { _id: 'a', order: 1, createdAt: new Date('2026-01-03') },
    { _id: 'c', order: 2, createdAt: new Date('2026-01-01') },
  ];
  const result = numberTasksForProject('DBS', tasks);
  assert.deepEqual(result, [
    { _id: 'a', taskSeq: 1, taskCode: 'DBS-001' },
    { _id: 'c', taskSeq: 2, taskCode: 'DBS-002' },
    { _id: 'b', taskSeq: 3, taskCode: 'DBS-003' },
  ]);
});

test('numberTasksForProject returns one entry per task', () => {
  const result = numberTasksForProject('DBS', [{ _id: 'a', order: 0, createdAt: new Date() }]);
  assert.equal(result.length, 1);
});
