import test from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { linkTicket } from '../devTicket.validation.js';

const mongoId = '507f1f77bcf86cd799439011';
const devDisplayId = 'DEV-MRN8XTOF-19D0A8FC';

const validateLink = (params, body) => Joi.compile(linkTicket).validate({ params, body });

test('linkTicket accepts human-readable DEV ticket id in body', () => {
  const { error, value } = validateLink(
    { ticketId: mongoId },
    { rel: 'relates-to', ticketId: devDisplayId }
  );
  assert.equal(error, undefined);
  assert.equal(value.body.ticketId, devDisplayId);
});

test('linkTicket accepts mongo id in body', () => {
  const linkedId = '507f1f77bcf86cd799439012';
  const { error, value } = validateLink(
    { ticketId: mongoId },
    { rel: 'relates-to', ticketId: linkedId }
  );
  assert.equal(error, undefined);
  assert.equal(value.body.ticketId, linkedId);
});

test('linkTicket rejects invalid ticket reference', () => {
  const { error } = validateLink(
    { ticketId: mongoId },
    { rel: 'relates-to', ticketId: 'not-a-ticket' }
  );
  assert.ok(error);
  assert.match(String(error.message), /mongo id or DEV ticket id/i);
});
