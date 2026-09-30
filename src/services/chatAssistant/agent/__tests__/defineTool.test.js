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

  it('carries an optional timeoutMs up to 15000, undefined when omitted', () => {
    assert.equal(defineTool(validDef({ timeoutMs: 15000 })).timeoutMs, 15000);
    assert.equal(defineTool(validDef()).timeoutMs, undefined);
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

  it('rejects a timeoutMs that is not an integer from 1 to 15000', () => {
    for (const timeoutMs of [0, -1, 15001, 1.5, '5000', null]) {
      assert.throws(() => defineTool(validDef({ timeoutMs })), /count_jobs.*timeoutMs/);
    }
  });

  it('surfaces unsupported Joi features in the input at load time', () => {
    assert.throws(
      () => defineTool(validDef({ input: Joi.object({ postedAt: Joi.date() }) })),
      /count_jobs.*Unsupported Joi feature 'date'/
    );
  });
});

describe('defineTool access rules', () => {
  it('accepts allOf, alone or together with anyOf', () => {
    assert.deepEqual(defineTool(validDef({ access: { allOf: ['jobs.read', 'jobs.manage'] } })).access, {
      allOf: ['jobs.read', 'jobs.manage'],
    });
    assert.doesNotThrow(() => defineTool(validDef({ access: { anyOf: ['jobs.read'], allOf: ['jobs.manage'] } })));
  });

  it('rejects an empty or non-string allOf', () => {
    assert.throws(() => defineTool(validDef({ access: { allOf: [] } })), /count_jobs.*access/);
    assert.throws(() => defineTool(validDef({ access: { allOf: [''] } })), /count_jobs.*access/);
    assert.throws(() => defineTool(validDef({ access: { anyOf: ['jobs.read'], allOf: [] } })), /count_jobs.*access/);
  });
});

describe('defineTool write tools', () => {
  const writeDef = (overrides = {}) => ({
    ...validDef({ name: 'close_jobs', kind: 'write', execute: undefined }),
    prepare: async () => ({ ok: false, error: 'nothing' }),
    commit: async () => ({ ok: true, message: 'done' }),
    ...overrides,
  });

  it('accepts prepare + commit, defaults maxTargets to 50, keeps recheck', () => {
    const recheck = async () => ({ ok: true });
    const tool = defineTool(writeDef({ recheck }));
    assert.equal(tool.kind, 'write');
    assert.equal(typeof tool.prepare, 'function');
    assert.equal(typeof tool.commit, 'function');
    assert.equal(tool.recheck, recheck);
    assert.equal(tool.maxTargets, 50);
    assert.equal(tool.execute, undefined);
    assert.equal(defineTool(writeDef()).recheck, undefined);
    assert.equal(defineTool(writeDef({ maxTargets: 10 })).maxTargets, 10);
  });

  it('rejects a write tool defined with execute instead of prepare/commit', () => {
    const executeOnly = writeDef({ prepare: undefined, commit: undefined, execute: async () => ({}) });
    assert.throws(() => defineTool(executeOnly), /close_jobs.*not execute/);
    assert.throws(() => defineTool(writeDef({ execute: async () => ({}) })), /close_jobs.*not execute/);
  });

  it('rejects a write tool missing prepare or commit', () => {
    assert.throws(() => defineTool(writeDef({ prepare: undefined })), /close_jobs.*prepare/);
    assert.throws(() => defineTool(writeDef({ commit: undefined })), /close_jobs.*commit/);
  });

  it('rejects a non-function recheck and a maxTargets outside 1..50', () => {
    assert.throws(() => defineTool(writeDef({ recheck: 'nope' })), /close_jobs.*recheck/);
    for (const maxTargets of [0, 51, 1.5, '10']) {
      assert.throws(() => defineTool(writeDef({ maxTargets })), /close_jobs.*maxTargets/);
    }
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
