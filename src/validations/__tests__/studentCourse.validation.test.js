import test from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { markItemComplete } from '../studentCourse.validation.js';

const STUDENT_ID = '507f1f77bcf86cd799439011';
const MODULE_ID = '507f1f77bcf86cd799439012';

const validateMarkItemComplete = (body) =>
  Joi.compile(markItemComplete).validate({
    params: { studentId: STUDENT_ID, moduleId: MODULE_ID },
    body,
  });

test('markItemComplete accepts essay contentType', () => {
  const { error } = validateMarkItemComplete({
    playlistItemId: '3',
    contentType: 'essay',
  });
  assert.equal(error, undefined);
});

test('markItemComplete accepts upload-video contentType', () => {
  const { error } = validateMarkItemComplete({
    playlistItemId: '0',
    contentType: 'upload-video',
  });
  assert.equal(error, undefined);
});

test('markItemComplete rejects unknown contentType', () => {
  const { error } = validateMarkItemComplete({
    playlistItemId: '0',
    contentType: 'unknown-type',
  });
  assert.ok(error);
});
