import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { defineTool } from '../defineTool.js';
import { getAgentTools, HANDOFF_TOOL_NAME, matchedDomains, hasAgentToolAccess } from '../toolRegistry.js';
import config from '../../../../config/config.js';

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });

// ─── Fake domains ───────────────────────────────────────────────────────────

const readTool = defineTool({
  name: 'fake_read',
  domain: 'domain_a',
  kind: 'read',
  description: 'A fake read tool, gated on domain_a.read.',
  input: Joi.object({ q: Joi.string() }),
  access: { anyOf: ['domain_a.read'] },
  execute: async (args) => ({ echo: args }),
});

const throwTool = defineTool({
  name: 'fake_throw',
  domain: 'domain_a',
  kind: 'read',
  description: 'Always throws, for error-handling tests.',
  input: Joi.object({}),
  access: { anyOf: ['domain_a.read'] },
  execute: async () => {
    throw new Error('boom');
  },
});

const strictTool = defineTool({
  name: 'fake_strict',
  domain: 'domain_a',
  kind: 'read',
  description: 'Requires a string name, for Joi-validation-error tests.',
  input: Joi.object({ name: Joi.string().required() }),
  access: { anyOf: ['domain_a.read'] },
  execute: async (args) => ({ got: args }),
});

const slowTool = defineTool({
  name: 'fake_slow',
  domain: 'domain_a',
  kind: 'read',
  description: 'Resolves slowly, for timeout tests.',
  input: Joi.object({}),
  access: { anyOf: ['domain_a.read'] },
  execute: () => new Promise((resolve) => setTimeout(() => resolve({ slow: true }), 400)),
});

const bigTool = defineTool({
  name: 'fake_big',
  domain: 'domain_a',
  kind: 'read',
  description: 'Returns an oversized array, for size-cap tests.',
  input: Joi.object({}),
  access: { anyOf: ['domain_a.read'] },
  execute: async () => ({
    items: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `Job title number ${i}`.padEnd(40, '.') })),
  }),
});

const renderTool = defineTool({
  name: 'fake_render',
  domain: 'domain_a',
  kind: 'read',
  description: 'Has a render function, for render-passthrough tests.',
  input: Joi.object({}),
  access: { anyOf: ['domain_a.read'] },
  execute: async () => ({ value: 42 }),
  render: (result) => ({ blocks: [`value=${result.value}`] }),
});

const domainA = {
  domain: 'domain_a',
  instructions: 'Domain A instructions.',
  tools: [readTool, throwTool, strictTool, slowTool, bigTool, renderTool],
};

const writeTool = defineTool({
  name: 'fake_write',
  domain: 'domain_b',
  kind: 'write',
  description: 'A write-kind tool, for write-refusal tests.',
  input: Joi.object({}),
  access: { anyOf: ['domain_b.write'] },
  execute: async () => ({ wrote: true }),
});

const domainB = {
  domain: 'domain_b',
  instructions: 'Domain B instructions.',
  tools: [writeTool],
};

const FAKE_DOMAINS = [domainA, domainB];

// ─── Access filtering ───────────────────────────────────────────────────────

describe('getAgentTools — access filtering', () => {
  it('hides a tool without permission: absent from schemas, execute returns a not-permitted error', async () => {
    const user = userWith();
    const { schemas, execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    assert.equal(schemas.some((s) => s.name === 'fake_read'), false);

    const result = await execute('fake_read', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /domain_a\.read/);
  });

  it('shows the tool once the user has the required permission', async () => {
    const user = userWith('domain_a.read');
    const { schemas, execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    assert.equal(schemas.some((s) => s.name === 'fake_read'), true);

    const result = await execute('fake_read', { q: 'hi' });
    assert.deepEqual(result, { ok: true, result: { echo: { q: 'hi' } } });
  });

  it('platformSuperUser sees every tool with no permissions granted', async () => {
    const user = { ...userWith(), platformSuperUser: true };
    const { schemas } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const names = schemas.map((s) => s.name).sort();
    assert.deepEqual(names, ['fake_big', 'fake_read', 'fake_render', 'fake_slow', 'fake_strict', 'fake_throw', 'fake_write', 'handoff']);
  });

  it('rejects an unknown tool name with an error, not a throw', async () => {
    const { execute } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    const result = await execute('does_not_exist', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown tool/);
  });
});

// ─── Schemas ────────────────────────────────────────────────────────────────

describe('getAgentTools — schemas', () => {
  it('sorts schemas by name and includes the handoff tool in Responses shape', async () => {
    const user = { ...userWith(), platformSuperUser: true };
    const { schemas } = await getAgentTools(user, { domains: FAKE_DOMAINS });

    const names = schemas.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes('handoff'));

    const handoffSchema = schemas.find((s) => s.name === 'handoff');
    assert.deepEqual(handoffSchema, {
      type: 'function',
      name: 'handoff',
      description: handoffSchema.description,
      parameters: { type: 'object', properties: { reason: { type: 'string', maxLength: 300 } }, additionalProperties: false },
      strict: false,
    });
  });

  it('handoff is always present regardless of permissions', async () => {
    const { schemas } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    assert.ok(schemas.some((s) => s.name === 'handoff'));
  });
});

// ─── Instructions ───────────────────────────────────────────────────────────

describe('getAgentTools — instructions', () => {
  it('includes instructions only for domains with >=1 permitted tool, sorted by domain', async () => {
    const user = userWith('domain_a.read', 'domain_b.write');
    const { instructions } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    assert.equal(instructions, 'Domain A instructions.\n\nDomain B instructions.');
  });

  it('omits a domain entirely when the user has none of its tools', async () => {
    const user = userWith('domain_a.read');
    const { instructions } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    assert.equal(instructions, 'Domain A instructions.');
  });

  it('is an empty string when no domain tool is permitted (handoff carries no domain instructions)', async () => {
    const { instructions } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    assert.equal(instructions, '');
  });
});

// ─── execute: args ──────────────────────────────────────────────────────────

describe('getAgentTools — execute: argument handling', () => {
  it('bad args -> {ok:false} with the Joi message, never throws', async () => {
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_strict', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /"name" is required/);
  });

  it('accepts string args, parsing JSON', async () => {
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_strict', JSON.stringify({ name: 'Prakhar' }));
    assert.deepEqual(result, { ok: true, result: { got: { name: 'Prakhar' } } });
  });

  it('malformed JSON string args -> error, never throws', async () => {
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_strict', '{not json');
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid arguments/);
  });
});

// ─── execute: failures ──────────────────────────────────────────────────────

describe('getAgentTools — execute: tool failures', () => {
  it('a throwing execute -> {ok:false}, never throws out of the registry', async () => {
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_throw', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /boom/);
  });

  it('write-kind tool is refused inside the loop', async () => {
    const user = userWith('domain_b.write');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_write', {});
    assert.deepEqual(result, { ok: false, error: 'write tools require confirmation' });
  });
});

// ─── execute: timeout ───────────────────────────────────────────────────────

describe('getAgentTools — execute: timeout', () => {
  const originalTimeoutMs = config.chatbot.agent.toolTimeoutMs;

  afterEach(() => {
    config.chatbot.agent.toolTimeoutMs = originalTimeoutMs;
  });

  it('a slow tool errors out once config.chatbot.agent.toolTimeoutMs elapses', async () => {
    config.chatbot.agent.toolTimeoutMs = 20;
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_slow', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
  });

  it('toolTimeoutMs <= 0 means no timeout: the slow tool still resolves', async () => {
    config.chatbot.agent.toolTimeoutMs = 0;
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_slow', {});
    assert.deepEqual(result, { ok: true, result: { slow: true } });
  });
});

// ─── execute: size cap ──────────────────────────────────────────────────────

describe('getAgentTools — execute: size cap', () => {
  it('shrinks an oversized result and tags truncated:true', async () => {
    const user = userWith('domain_a.read');
    const { execute } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_big', {});
    assert.equal(result.ok, true);
    assert.equal(result.result.truncated, true);
    assert.ok(result.result.items.length < 2000, 'items array must be shrunk');
    assert.ok(JSON.stringify(result.result).length <= 20000, 'result must fit the size cap');
  });
});

// ─── render ─────────────────────────────────────────────────────────────────

describe('getAgentTools — render', () => {
  it('passes a result through the tool render function', async () => {
    const user = userWith('domain_a.read');
    const { execute, render } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    const result = await execute('fake_render', {});
    assert.equal(result.ok, true);
    assert.deepEqual(render('fake_render', result.result), { blocks: ['value=42'] });
  });

  it('returns null for a tool with no render function', async () => {
    const user = userWith('domain_a.read');
    const { render } = await getAgentTools(user, { domains: FAKE_DOMAINS });
    assert.equal(render('fake_read', { echo: {} }), null);
  });

  it('returns null for the handoff tool (no render defined)', async () => {
    const { render } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    assert.equal(render(HANDOFF_TOOL_NAME, { handoff: true }), null);
  });
});

// ─── isHandoff ──────────────────────────────────────────────────────────────

describe('getAgentTools — isHandoff', () => {
  it('identifies the handoff tool by name', async () => {
    const { isHandoff } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    assert.equal(isHandoff(HANDOFF_TOOL_NAME), true);
    assert.equal(isHandoff('fake_read'), false);
  });
});

// ─── handoff execution ──────────────────────────────────────────────────────

describe('getAgentTools — handoff tool', () => {
  it('runs for any user regardless of permissions and returns {handoff:true}', async () => {
    const { execute } = await getAgentTools(userWith(), { domains: FAKE_DOMAINS });
    const result = await execute(HANDOFF_TOOL_NAME, { reason: 'outside migrated domains' });
    assert.deepEqual(result, { ok: true, result: { handoff: true } });
  });
});

// ─── duplicate tool names ───────────────────────────────────────────────────

describe('getAgentTools — duplicate tool names', () => {
  it('throws when two domains define the same tool name', async () => {
    const dupToolX = defineTool({
      name: 'dup_tool',
      domain: 'dup_a',
      kind: 'read',
      description: 'Duplicate name X.',
      input: Joi.object({}),
      access: { anyOf: ['dup_a.read'] },
      execute: async () => ({}),
    });
    const dupToolY = defineTool({
      name: 'dup_tool',
      domain: 'dup_b',
      kind: 'read',
      description: 'Duplicate name Y.',
      input: Joi.object({}),
      access: { anyOf: ['dup_b.read'] },
      execute: async () => ({}),
    });
    const dupDomains = [
      { domain: 'dup_a', instructions: 'Dup A.', tools: [dupToolX] },
      { domain: 'dup_b', instructions: 'Dup B.', tools: [dupToolY] },
    ];
    await assert.rejects(() => getAgentTools(userWith(), { domains: dupDomains }), /dup_tool/);
  });
});

// ─── matchedDomains / hasAgentToolAccess (agent/gate.js's domain-generic gate) ──

describe('matchedDomains', () => {
  const withMatch = { domain: 'has_matcher', instructions: '', matchesTurn: (text) => /widget/i.test(text), tools: [] };
  const withoutMatch = { domain: 'no_matcher', instructions: '', tools: [] };
  const domains = [withMatch, withoutMatch];

  it('returns the names of domains whose matchesTurn(text) is true', () => {
    assert.deepEqual(matchedDomains('how many widgets do we have', { domains }), ['has_matcher']);
  });

  it('skips a domain with no matchesTurn export, and returns [] when nothing matches', () => {
    assert.deepEqual(matchedDomains('anything at all', { domains }), []);
  });
});

describe('hasAgentToolAccess', () => {
  const domainA = { domain: 'domain_a', instructions: '', tools: [{ name: 't_a', access: { anyOf: ['a.read'] } }] };
  const domainB = { domain: 'domain_b', instructions: '', tools: [{ name: 't_b', access: { anyOf: ['b.read'] } }] };
  const domains = [domainA, domainB];

  it('is ok when the user holds a permission for a tool in one of the named domains', async () => {
    const result = await hasAgentToolAccess(userWith('a.read'), ['domain_a'], { domains });
    assert.equal(result.ok, true);
  });

  it('is not ok when the user has no tool permission in the named domains, even if permitted elsewhere', async () => {
    const result = await hasAgentToolAccess(userWith('b.read'), ['domain_a'], { domains });
    assert.equal(result.ok, false);
  });

  it('with domainNames:null, checks every registered domain (the recent-agent-turn case)', async () => {
    const result = await hasAgentToolAccess(userWith('b.read'), null, { domains });
    assert.equal(result.ok, true);
  });

  it('platformSuperUser passes with no permissions granted', async () => {
    const result = await hasAgentToolAccess({ ...userWith(), platformSuperUser: true }, ['domain_a'], { domains });
    assert.equal(result.ok, true);
  });
});
