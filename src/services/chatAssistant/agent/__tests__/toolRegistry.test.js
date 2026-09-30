import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { defineTool } from '../defineTool.js';
import {
  getAgentTools,
  HANDOFF_TOOL_NAME,
  FIND_TOOLS_NAME,
  EAGER_TOOL_LIMIT,
  LAZY_INSTRUCTIONS,
  assertDomainSummaries,
} from '../toolRegistry.js';
import config from '../../../../config/config.js';
import registeredDomains from '../tools/index.js';

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
  summary: 'Domain A things.',
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
  summary: 'Domain B things.',
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

  const slowWithTimeout = (name, timeoutMs) =>
    defineTool({
      name,
      domain: 'domain_t',
      kind: 'read',
      description: 'Resolves slowly, with its own timeoutMs.',
      input: Joi.object({}),
      access: { anyOf: ['domain_t.read'] },
      timeoutMs,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ slow: true }), 100)),
    });
  const timeoutDomains = [
    {
      domain: 'domain_t',
      summary: 'Domain T things.',
      instructions: 'Domain T instructions.',
      tools: [slowWithTimeout('fake_short_timeout', 20), slowWithTimeout('fake_long_timeout', 1000)],
    },
  ];

  it("a tool's own timeoutMs overrides the config: shorter times out", async () => {
    config.chatbot.agent.toolTimeoutMs = 0;
    const { execute } = await getAgentTools(userWith('domain_t.read'), { domains: timeoutDomains });
    const result = await execute('fake_short_timeout', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 20ms/);
  });

  it("a tool's own timeoutMs overrides the config: longer outlives it", async () => {
    config.chatbot.agent.toolTimeoutMs = 20;
    const { execute } = await getAgentTools(userWith('domain_t.read'), { domains: timeoutDomains });
    assert.deepEqual(await execute('fake_long_timeout', {}), { ok: true, result: { slow: true } });
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
      { domain: 'dup_a', summary: 'Dup A.', instructions: 'Dup A.', tools: [dupToolX] },
      { domain: 'dup_b', summary: 'Dup B.', instructions: 'Dup B.', tools: [dupToolY] },
    ];
    await assert.rejects(() => getAgentTools(userWith(), { domains: dupDomains }), /dup_tool/);
  });
});

describe('getAgentTools — measure', () => {
  const measuredTool = defineTool({
    name: 'fake_measured',
    domain: 'domain_m',
    kind: 'read',
    description: 'Counts fake things.',
    measure: 'Fake RECORDS, active unless filters.status is set.',
    input: Joi.object({}),
    access: { anyOf: ['m.read'] },
    execute: async () => ({ total: 3 }),
  });
  const domains = [{ domain: 'domain_m', summary: 'M.', instructions: 'M.', tools: [measuredTool] }];

  it('appends the measure to the model-facing description and to the result', async () => {
    const { schemas, execute } = await getAgentTools(userWith('m.read'), { domains });
    const schema = schemas.find((s) => s.name === 'fake_measured');
    assert.equal(schema.description, 'Counts fake things. Measure: Fake RECORDS, active unless filters.status is set.');
    assert.deepEqual(await execute('fake_measured', {}), {
      ok: true,
      result: { total: 3, measure: 'Fake RECORDS, active unless filters.status is set.' },
    });
  });

  // Guard: a count/list tool without a measure is how "20 candidates" got reported as if it were the
  // Users page's number. Every future domain's count_*/list_* tool must say what it counts.
  it('every registered count_*/list_* read tool declares a non-empty measure', () => {
    const missing = registeredDomains
      .flatMap((d) => d.tools)
      .filter((t) => t.kind === 'read' && /^(count|list)_/.test(t.name))
      .filter((t) => typeof t.measure !== 'string' || !t.measure.trim())
      .map((t) => t.name);
    assert.deepEqual(missing, []);
  });
});

// ─── domain summaries ───────────────────────────────────────────────────────

describe('getAgentTools — domain summaries', () => {
  it('rejects a domain with no summary', async () => {
    const noSummary = { ...domainA, summary: undefined };
    await assert.rejects(() => getAgentTools(userWith(), { domains: [noSummary] }), /domain_a.*summary/);
  });

  it('rejects a summary over 120 characters or spanning lines', () => {
    assert.throws(() => assertDomainSummaries([{ ...domainA, summary: 'x'.repeat(121) }]), /120/);
    assert.throws(() => assertDomainSummaries([{ ...domainA, summary: 'one\ntwo' }]), /one line/);
    assert.doesNotThrow(() => assertDomainSummaries([{ ...domainA, summary: 'x'.repeat(120) }]));
  });
});

// ─── lazy loading ───────────────────────────────────────────────────────────

const cTool = defineTool({
  name: 'fake_c',
  domain: 'domain_c',
  kind: 'read',
  description: 'Gated on domain_c.read.',
  input: Joi.object({}),
  access: { anyOf: ['domain_c.read'] },
  execute: async () => ({ c: true }),
});
const domainC = { domain: 'domain_c', summary: 'Domain C things.', instructions: 'Domain C instructions.', tools: [cTool] };
const LAZY_DOMAINS = [domainA, domainB, domainC];

describe('getAgentTools — eager vs lazy', () => {
  it('defaults to EAGER_TOOL_LIMIT = 30', () => {
    assert.equal(EAGER_TOOL_LIMIT, 30);
  });

  it('at or under the limit: eager, schemas and instructions identical to an unlimited registry', async () => {
    const user = userWith('domain_a.read', 'domain_b.write');
    const atLimit = await getAgentTools(user, { domains: FAKE_DOMAINS, eagerLimit: 7 });
    const unlimited = await getAgentTools(user, { domains: FAKE_DOMAINS, eagerLimit: Infinity });
    assert.equal(atLimit.lazy, false);
    assert.deepEqual(atLimit.schemas, unlimited.schemas);
    assert.equal(atLimit.instructions, unlimited.instructions);
    assert.equal(atLimit.instructions, 'Domain A instructions.\n\nDomain B instructions.');
    assert.ok(!atLimit.schemas.some((s) => s.name === FIND_TOOLS_NAME));
  });

  it('above the limit: lazy, offers only find_tools + handoff and the lazy instructions', async () => {
    const reg = await getAgentTools(userWith('domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    assert.equal(reg.lazy, true);
    assert.deepEqual(reg.schemas.map((s) => s.name), [FIND_TOOLS_NAME, HANDOFF_TOOL_NAME]);
    assert.equal(reg.instructions, LAZY_INSTRUCTIONS);
    assert.doesNotMatch(reg.instructions, /Domain A instructions/);
  });

  it('find_tools catalog and enum list only the permitted domains, sorted', async () => {
    const reg = await getAgentTools(userWith('domain_c.read', 'domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    const find = reg.schemas.find((s) => s.name === FIND_TOOLS_NAME);
    assert.match(find.description, /- domain_a — Domain A things\.\n- domain_c — Domain C things\./);
    assert.doesNotMatch(find.description, /domain_b/);
    assert.deepEqual(find.parameters.properties.domains.items.enum, ['domain_a', 'domain_c']);
    assert.equal(find.parameters.properties.domains.maxItems, 5);
    assert.equal(find.parameters.properties.domains.minItems, 1);
    assert.equal(find.parameters.properties.domains.uniqueItems, true);
    assert.deepEqual(find.parameters.required, ['domains']);
  });

  it('eager registry: find_tools is not a loop tool, so a hallucinated call is an unknown tool', async () => {
    const reg = await getAgentTools(userWith('domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: Infinity });
    assert.equal(reg.lazy, false);
    assert.equal(reg.isFindTools(FIND_TOOLS_NAME), false);
    assert.deepEqual(await reg.execute(FIND_TOOLS_NAME, { domains: ['domain_a'] }), {
      ok: false,
      error: `Unknown tool '${FIND_TOOLS_NAME}'.`,
    });
  });

  it('a permitted tool the model calls without loading its domain still runs, with access re-checked', async () => {
    const reg = await getAgentTools(userWith('domain_c.read'), { domains: LAZY_DOMAINS, eagerLimit: 0 });
    assert.equal(reg.lazy, true);
    assert.deepEqual(await reg.execute('fake_c', {}), { ok: true, result: { c: true } });
    const denied = await reg.execute('fake_read', {});
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Requires one of/);
  });

  it('loadDomains returns only permitted tools; unknown and unpermitted domains load nothing', async () => {
    const reg = await getAgentTools(userWith('domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    const out = reg.loadDomains(['domain_c', 'domain_b', 'nope', 'domain_a']);
    assert.deepEqual(out.loaded, ['domain_a']);
    assert.deepEqual(out.schemas.map((s) => s.name), domainA.tools.map((t) => t.name).sort());
    assert.equal(out.instructions, 'Domain A instructions.');
    assert.deepEqual(reg.loadDomains(['domain_c']), { schemas: [], instructions: '', loaded: [] });
  });

  it('parseFindToolsArgs: requires 1–5 unique permitted domain names', async () => {
    const reg = await getAgentTools(userWith('domain_a.read', 'domain_c.read'), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    assert.deepEqual(reg.parseFindToolsArgs('{"domains":["domain_a","domain_c"]}'), { domains: ['domain_a', 'domain_c'] });
    assert.ok(reg.parseFindToolsArgs({ domains: [] }).error);
    assert.ok(reg.parseFindToolsArgs({ domains: ['domain_a', 'domain_a'] }).error);
    assert.ok(reg.parseFindToolsArgs({ domains: ['domain_b'] }).error);
    assert.ok(reg.parseFindToolsArgs({}).error);
    assert.match(reg.parseFindToolsArgs('{bad').error, /Invalid arguments/);
  });

  it('execute refuses find_tools: the loop handles it', async () => {
    const reg = await getAgentTools(userWith('domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    assert.deepEqual(await reg.execute(FIND_TOOLS_NAME, { domains: ['domain_a'] }), {
      ok: false,
      error: 'find_tools is handled by the loop',
    });
    assert.equal(reg.isFindTools(FIND_TOOLS_NAME), true);
    assert.equal(reg.isFindTools('fake_read'), false);
  });

  it('domainOfTool maps a tool to its domain module, unknown → null', async () => {
    const reg = await getAgentTools(userWith(), { domains: LAZY_DOMAINS, eagerLimit: 2 });
    assert.equal(reg.domainOfTool('fake_c'), 'domain_c');
    assert.equal(reg.domainOfTool('nope'), null);
  });

  it('handoff does not count toward the limit', async () => {
    const reg = await getAgentTools(userWith('domain_a.read'), { domains: LAZY_DOMAINS, eagerLimit: domainA.tools.length });
    assert.equal(reg.lazy, false);
  });
});
