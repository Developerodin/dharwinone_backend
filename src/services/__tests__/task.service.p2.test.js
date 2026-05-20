import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  parseCommaList,
  applyCommaFilter,
  expandPriorityFilterForDefaultMedium,
  sanitizeTaskWritePayload,
} from '../task.service.js';

test('parseCommaList trims and drops empties', () => {
  assert.deepEqual(parseCommaList(' high, medium ,,urgent '), ['high', 'medium', 'urgent']);
});

test('applyCommaFilter builds $in for multiple values', () => {
  const filter = { priority: 'high,low' };
  applyCommaFilter(filter, 'priority');
  assert.deepEqual(filter.priority, { $in: ['high', 'low'] });
});

test('applyCommaFilter keeps single value scalar', () => {
  const filter = { priority: 'urgent' };
  applyCommaFilter(filter, 'priority');
  assert.equal(filter.priority, 'urgent');
});

test('expandPriorityFilterForDefaultMedium includes missing priority when filtering medium', () => {
  const filter = { priority: 'medium' };
  applyCommaFilter(filter, 'priority');
  expandPriorityFilterForDefaultMedium(filter);
  assert.deepEqual(filter.priority, { $in: ['medium', null, ''] });
});

test('expandPriorityFilterForDefaultMedium does not expand non-medium filters', () => {
  const filter = { priority: 'high' };
  applyCommaFilter(filter, 'priority');
  expandPriorityFilterForDefaultMedium(filter);
  assert.equal(filter.priority, 'high');
});

test('applyCommaFilter converts sprintId to ObjectId', () => {
  const id = '507f1f77bcf86cd799439011';
  const filter = { sprintId: `${id},507f1f77bcf86cd799439012` };
  applyCommaFilter(filter, 'sprintId', (v) => new mongoose.Types.ObjectId(v));
  assert.equal(filter.sprintId.$in.length, 2);
  assert.ok(filter.sprintId.$in[0] instanceof mongoose.Types.ObjectId);
});

test('sanitizeTaskWritePayload strips server counters and blank sprintId', () => {
  const out = sanitizeTaskWritePayload({
    title: 'x',
    likesCount: 9,
    commentsCount: 3,
    attachmentsCount: 2,
    sprintId: '',
  });
  assert.equal(out.title, 'x');
  assert.equal(out.likesCount, undefined);
  assert.equal(out.commentsCount, undefined);
  assert.equal(out.attachmentsCount, undefined);
  assert.equal(out.sprintId, null);
});
