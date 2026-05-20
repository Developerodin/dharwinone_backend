import test from 'node:test';
import assert from 'node:assert/strict';
import Position from '../position.model.js';

test('Position accepts department string', () => {
  const p = new Position({ name: 'Frontend Engineer', department: 'Engineering' });
  assert.equal(p.department, 'Engineering');
});
test('Position defaults skillsSuggested to empty array', () => {
  const p = new Position({ name: 'Designer' });
  assert.deepEqual(p.skillsSuggested, []);
});
test('Position accepts skillsSuggested array', () => {
  const p = new Position({ name: 'AI Engineer', skillsSuggested: ['Python', 'PyTorch'] });
  assert.deepEqual([...p.skillsSuggested], ['Python', 'PyTorch']);
});
test('Position declares a department index', () => {
  const hasDept = Position.schema.indexes().some(([def]) => def.department === 1);
  assert.equal(hasDept, true);
});
test('Position still exposes isNameTaken static', () => {
  assert.equal(typeof Position.isNameTaken, 'function');
});
