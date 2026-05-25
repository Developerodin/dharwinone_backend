import test from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import {
  postSalesAgentAssign,
  patchSalesAgentChange,
  deleteSalesAgent,
  patchAttributionJob,
} from '../employee.validation.js';

const validId = '507f1f77bcf86cd799439011';

test('postSalesAgentAssign requires salesAgentUserId', () => {
  const { error } = Joi.compile(postSalesAgentAssign.body).validate({});
  assert.ok(error);
});

test('postSalesAgentAssign rejects future assignedAt', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const { error } = Joi.compile(postSalesAgentAssign.body).validate({
    salesAgentUserId: validId,
    assignedAt: future,
  });
  assert.ok(error);
});

test('patchSalesAgentChange requires expectedCurrentAttributionId', () => {
  const { error } = Joi.compile(patchSalesAgentChange.body).validate({
    salesAgentUserId: validId,
  });
  assert.ok(error);
});

test('deleteSalesAgent requires revokeReason', () => {
  const { error } = Joi.compile(deleteSalesAgent.body).validate({
    expectedCurrentAttributionId: validId,
  });
  assert.ok(error);
});

test('patchAttributionJob accepts null jobId without reason', () => {
  const { error, value } = Joi.compile(patchAttributionJob.body).validate({ jobId: null });
  assert.equal(error, undefined);
  assert.equal(value.jobId, null);
});
