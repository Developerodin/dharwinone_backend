import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskBreakdown } from '../pmAssistant.validation.js';
import { HARD_TASK_CEILING } from '../../constants/pmAssistant.js';

const makeTasks = (n) => Array.from({ length: n }, (_, i) => ({ title: `Task ${i + 1}` }));

test('HARD_TASK_CEILING is 180 (true product ceiling)', () => {
  assert.equal(HARD_TASK_CEILING, 180);
});

test('applyTaskBreakdown accepts a tasks array of length 60', () => {
  const { error } = applyTaskBreakdown.body.validate({ tasks: makeTasks(60) });
  assert.equal(error, undefined);
});

test('applyTaskBreakdown accepts a tasks array of length 180 (HARD_TASK_CEILING)', () => {
  const { error } = applyTaskBreakdown.body.validate({ tasks: makeTasks(HARD_TASK_CEILING) });
  assert.equal(error, undefined);
});

test('applyTaskBreakdown rejects a tasks array of length 181', () => {
  const { error } = applyTaskBreakdown.body.validate({ tasks: makeTasks(HARD_TASK_CEILING + 1) });
  assert.ok(error, 'expected a validation error for 181 tasks');
  assert.equal(
    error.message,
    `A task breakdown can include at most ${HARD_TASK_CEILING} tasks.`
  );
});

test('applyTaskBreakdown rejects an empty tasks array', () => {
  const { error } = applyTaskBreakdown.body.validate({ tasks: [] });
  assert.ok(error);
  assert.equal(error.message, 'A task breakdown must include at least one task.');
});

test('applyTaskBreakdown rejects a missing tasks array', () => {
  const { error } = applyTaskBreakdown.body.validate({});
  assert.ok(error);
  assert.equal(error.message, 'tasks array is required.');
});
