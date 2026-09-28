import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { defineTool, assertUniqueToolNames } from '../defineTool.js';

function validDef(overrides = {}) {
  return {
    name: 'count_jobs',
    domain: 'jobs',
    kind: 'read',
    description: 'Counts jobs matching a filter.',
    input: Joi.object({ search: Joi.string() }),
    access: { anyOf: ['jobs.read'] },
    execute: async () => ({ total: 0 }),
    ...overrides,
  };
}

describe('defineTool happy path', () => {
  it('returns a frozen tool object carrying the computed jsonSchema', () => {
    const tool = defineTool(validDef());
    assert.equal(tool.name, 'count_jobs');
    assert.equal(tool.domain, 'jobs');
    assert.equal(tool.kind, 'read');
    assert.deepEqual(tool.jsonSchema, {
      type: 'object',
      properties: { search: { type: 'string' } },
      additionalProperties: false,
    });
    assert.equal(Object.isFrozen(tool), true);
  });

  it('accepts an access note in place of anyOf', () => {
    const tool = defineTool(validDef({ access: { note: 'handler enforces access' } }));
    assert.deepEqual(tool.access, { note: 'handler enforces access' });
  });

  it('accepts an optional render function', () => {
    const render = (result) => ({ blocks: [], facts: result });
    const tool = defineTool(validDef({ render }));
    assert.equal(tool.render, render);
  });

  it('leaves render undefined when omitted', () => {
    const tool = defineTool(validDef());
    assert.equal(tool.render, undefined);
  });
});

describe('defineTool rejects bad definitions', () => {
  it('rejects a missing name', () => {
    assert.throws(() => defineTool(validDef({ name: undefined })), /name/);
  });

  it('rejects a name that fails the pattern (uppercase)', () => {
    assert.throws(() => defineTool(validDef({ name: 'Count_Jobs' })), /name/);
  });

  it('rejects a name that is too short', () => {
    assert.throws(() => defineTool(validDef({ name: 'ab' })), /name/);
  });

  it('rejects a name with a dash', () => {
    assert.throws(() => defineTool(validDef({ name: 'count-jobs' })), /name/);
  });

  it('rejects a missing domain', () => {
    assert.throws(() => defineTool(validDef({ domain: undefined })), /count_jobs.*domain/);
  });

  it('rejects an empty domain', () => {
    assert.throws(() => defineTool(validDef({ domain: '' })), /domain/);
  });

  it('rejects a bad kind', () => {
    assert.throws(() => defineTool(validDef({ kind: 'delete' })), /count_jobs.*kind/);
  });

  it('rejects a missing description', () => {
    assert.throws(() => defineTool(validDef({ description: undefined })), /count_jobs.*description/);
  });

  it('rejects a non-Joi input', () => {
    assert.throws(() => defineTool(validDef({ input: { search: 'string' } })), /count_jobs.*input/);
  });

  it('rejects a non-object Joi input', () => {
    assert.throws(() => defineTool(validDef({ input: Joi.string() })), /count_jobs.*input/);
  });

  it('rejects a missing access', () => {
    assert.throws(() => defineTool(validDef({ access: undefined })), /count_jobs.*access/);
  });

  it('rejects an access with an empty anyOf array', () => {
    assert.throws(() => defineTool(validDef({ access: { anyOf: [] } })), /count_jobs.*access/);
  });

  it('rejects an access object with neither anyOf nor note', () => {
    assert.throws(() => defineTool(validDef({ access: {} })), /count_jobs.*access/);
  });

  it('rejects a missing execute', () => {
    assert.throws(() => defineTool(validDef({ execute: undefined })), /count_jobs.*execute/);
  });

  it('rejects a non-function execute', () => {
    assert.throws(() => defineTool(validDef({ execute: 'nope' })), /count_jobs.*execute/);
  });

  it('rejects a render that is present but not a function', () => {
    assert.throws(() => defineTool(validDef({ render: 'nope' })), /count_jobs.*render/);
  });

  it('surfaces unsupported Joi features in the input at load time', () => {
    assert.throws(
      () => defineTool(validDef({ input: Joi.object({ postedAt: Joi.date() }) })),
      /count_jobs.*Unsupported Joi feature 'date'/
    );
  });
});

describe('assertUniqueToolNames', () => {
  it('does not throw when all names are unique', () => {
    const tools = [validDef(), validDef({ name: 'fetch_jobs' })].map(defineTool);
    assert.doesNotThrow(() => assertUniqueToolNames(tools));
  });

  it('throws when a name is duplicated, naming the duplicate', () => {
    const tools = [validDef(), validDef()].map(defineTool);
    assert.throws(() => assertUniqueToolNames(tools), /count_jobs/);
  });
});
