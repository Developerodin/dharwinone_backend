import { test } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import * as teamValidation from '../team.validation.js';

test('createTeamMember accepts employeeId (objectid)', () => {
  const schema = Joi.compile(teamValidation.createTeamMember.body);
  const { error } = schema.validate({
    employeeId: '507f1f77bcf86cd799439011',
    teamId:     '507f1f77bcf86cd799439012',
    seniority:  'Lead',
  });
  assert.equal(error, undefined);
});

test('createTeamMember rejects denormalized name/email-only payload', () => {
  const schema = Joi.compile(teamValidation.createTeamMember.body);
  const { error } = schema.validate({ name: 'x', email: 'x@y.com' });
  assert.ok(error, 'should require employeeId');
});
