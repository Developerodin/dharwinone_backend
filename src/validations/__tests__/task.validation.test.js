import test from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { getTasks } from '../task.validation.js';

const validateQuery = (query) => Joi.compile(getTasks).validate({ query });

test('getTasks accepts unassigned=true (API client format)', () => {
  const { error, value } = validateQuery({ unassigned: 'true', page: '1', limit: '20' });
  assert.equal(error, undefined);
  assert.equal(value.query.unassigned, true);
});

test('getTasks accepts unassigned=1 (task board URL format)', () => {
  const { error, value } = validateQuery({ unassigned: '1' });
  assert.equal(error, undefined);
  assert.equal(value.query.unassigned, '1');
});

test('getTasks accepts leaving=1 and reassigned=1', () => {
  assert.equal(validateQuery({ leaving: '1' }).error, undefined);
  assert.equal(validateQuery({ reassigned: '1' }).error, undefined);
});

test('getTasks rejects invalid unassigned values', () => {
  assert.ok(validateQuery({ unassigned: 'yes' }).error);
  assert.ok(validateQuery({ unassigned: '' }).error);
});

test('getTasks accepts combined kanban filters from URL', () => {
  const { error } = validateQuery({
    unassigned: '1',
    leaving: '1',
    priority: 'low,medium,high,urgent',
    page: '1',
    limit: '20',
  });
  assert.equal(error, undefined);
});
