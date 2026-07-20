import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeetingsMongoFilter, parseCommaList } from '../../utils/meetingQueryFilter.js';

test('parseCommaList splits comma-separated values', () => {
  assert.deepEqual(parseCommaList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCommaList(['x', ' y ']), ['x', 'y']);
});

test('buildMeetingsMongoFilter maps UI filters to mongo clauses', () => {
  const filter = buildMeetingsMongoFilter({
    candidate: 'John,Jane',
    recruiter: 'Sarah',
    status: 'ended,scheduled',
    interviewType: 'Video,Phone',
    title: 'Backend',
  });

  assert.ok(filter.$and);
  assert.equal(filter.$and.length, 5);
  assert.deepEqual(filter.$and[0], { title: { $regex: 'Backend', $options: 'i' } });
});

test('buildMeetingsMongoFilter scopes export to posted ids', () => {
  const id = '507f1f77bcf86cd799439011';
  const filter = buildMeetingsMongoFilter({}, { ids: [id] });
  assert.equal(filter._id.$in.length, 1);
  assert.equal(String(filter._id.$in[0]), id);
});
