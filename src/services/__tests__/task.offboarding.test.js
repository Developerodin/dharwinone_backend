import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOffboardingMap, applyOffboardingFlags } from '../task.service.js';

const NOW = new Date('2026-06-23T10:00:00.000Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);

describe('buildOffboardingMap', () => {
  it('maps owner -> bucket for resigned and soon, drops out-of-window', () => {
    const emps = [
      { owner: 'u1', fullName: 'Amit', resignDate: daysFromNow(-2) },
      { owner: 'u2', fullName: 'Rahul', resignDate: daysFromNow(5) },
      { owner: 'u3', fullName: 'Old', resignDate: daysFromNow(40) },
    ];
    const m = buildOffboardingMap(emps, NOW);
    assert.equal(m.get('u1').bucket, 'resigned');
    assert.equal(m.get('u2').bucket, 'soon');
    assert.equal(m.has('u3'), false);
    assert.equal(m.get('u1').name, 'Amit');
  });
});

describe('applyOffboardingFlags', () => {
  const map = new Map([
    ['u1', { bucket: 'resigned', name: 'Amit', resignDate: daysFromNow(-2) }],
    ['u2', { bucket: 'soon', name: 'Rahul', resignDate: daysFromNow(5) }],
  ]);

  it('flags an open task whose assignee resigned', () => {
    const tasks = [{ _id: 't1', status: 'todo', assignedTo: [{ _id: 'u1' }] }];
    applyOffboardingFlags(tasks, map);
    assert.equal(tasks[0].offboardingFlag, 'resigned');
    assert.deepEqual(tasks[0].offboardingAssignees, [
      { id: 'u1', name: 'Amit', resignDate: daysFromNow(-2), bucket: 'resigned' },
    ]);
  });

  it('mixed assignees pick most severe (resigned > soon)', () => {
    const tasks = [{ _id: 't1', status: 'todo', assignedTo: [{ _id: 'u2' }, { _id: 'u1' }] }];
    applyOffboardingFlags(tasks, map);
    assert.equal(tasks[0].offboardingFlag, 'resigned');
    assert.equal(tasks[0].offboardingAssignees.length, 2);
  });

  it('never flags completed tasks', () => {
    const tasks = [{ _id: 't1', status: 'completed', assignedTo: [{ _id: 'u1' }] }];
    applyOffboardingFlags(tasks, map);
    assert.equal(tasks[0].offboardingFlag, undefined);
  });

  it('open task with no flagged assignee gets empty assignees, no flag', () => {
    const tasks = [{ _id: 't1', status: 'todo', assignedTo: [{ _id: 'uX' }] }];
    applyOffboardingFlags(tasks, map);
    assert.equal(tasks[0].offboardingFlag, undefined);
    assert.deepEqual(tasks[0].offboardingAssignees, []);
  });
});
