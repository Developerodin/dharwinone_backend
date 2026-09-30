import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import Joi from 'joi';
import { defineTool } from '../defineTool.js';

const userWith = (...perms) => ({ id: 'u1', roleIds: [], authContext: { permissions: new Set(perms) } });

let runTool;
let runTools;

const tool = (def) =>
  defineTool({ domain: 'fake', kind: 'read', description: 'Fake.', input: Joi.object({}), access: { anyOf: ['a.read'] }, ...def });

const writePrepare = mock.fn(async () => ({
  ok: true,
  summary: { title: 'Wrote', lines: [], targetCount: 0, targets: [] },
  payload: {},
}));
const writeCommit = mock.fn(async () => ({ ok: true, message: 'wrote' }));

const fakeDomains = [
  {
    domain: 'fake',
    summary: 'Fake things.',
    instructions: 'Fake.',
    tools: [
      tool({
        name: 'fake_echo',
        input: Joi.object({ q: Joi.string() }),
        execute: async (args, ctx) => ({ echo: args, depth: ctx.composeDepth, requestId: ctx.requestId }),
      }),
      tool({ name: 'fake_strict', input: Joi.object({ name: Joi.string().required() }), execute: async (args) => args }),
      tool({ name: 'fake_slow', execute: () => new Promise((resolve) => setTimeout(() => resolve({ slow: true }), 200)) }),
      tool({
        name: 'fake_throw',
        execute: async () => {
          throw new Error('boom');
        },
      }),
      tool({
        name: 'fake_person',
        access: { anyOf: ['a.read'], rowScope: 'person' },
        execute: async () => ({ name: 'Asha', salaryRange: '10-20 LPA' }),
      }),
      tool({ name: 'fake_write', kind: 'write', prepare: writePrepare, commit: writeCommit }),
      tool({
        name: 'fake_composite',
        access: { note: 'sections gate themselves' },
        execute: async (_args, ctx) => ({ inner: await runTool('fake_echo', { q: 'hi' }, ctx) }),
      }),
      tool({
        name: 'fake_loop',
        access: { note: 'sections gate themselves' },
        execute: async (_args, ctx) => ({ inner: await runTool('fake_loop', {}, ctx) }),
      }),
    ],
  },
];

before(async () => {
  mock.module('../tools/index.js', { defaultExport: fakeDomains });
  ({ runTool, runTools } = await import('../compose.js'));
});

// No row scope for the viewer, so the person guard only redacts salary.
const deps = { applyScope: async () => ({}) };
const ctxFor = (user) => ({ user, deps, requestId: 'r1' });

describe('compose runTool', () => {
  it('runs a permitted tool with validated args and passes ctx through, one level deeper', async () => {
    const out = await runTool('fake_echo', { q: 'hi' }, ctxFor(userWith('a.read')));
    assert.deepEqual(out, { status: 'ok', result: { echo: { q: 'hi' }, depth: 1, requestId: 'r1' } });
  });

  it('restricted when the caller lacks the tool permission, without running it', async () => {
    assert.deepEqual(await runTool('fake_echo', {}, ctxFor(userWith())), { status: 'restricted' });
  });

  it('invalid args return the Joi message', async () => {
    const out = await runTool('fake_strict', {}, ctxFor(userWith('a.read')));
    assert.equal(out.status, 'invalid');
    assert.match(out.error, /"name" is required/);
  });

  it('timeout once timeoutMs elapses', async () => {
    const out = await runTool('fake_slow', {}, ctxFor(userWith('a.read')), { timeoutMs: 20 });
    assert.deepEqual(out, { status: 'timeout' });
  });

  it('a thrown error becomes status error, never a throw', async () => {
    assert.deepEqual(await runTool('fake_throw', {}, ctxFor(userWith('a.read'))), { status: 'error', error: 'boom' });
  });

  it('unknown tool name', async () => {
    assert.deepEqual(await runTool('does_not_exist', {}, ctxFor(userWith('a.read'))), { status: 'unknown' });
  });

  it('refuses write tools: composite tools never draft, prepare and commit never run', async () => {
    assert.deepEqual(await runTool('fake_write', {}, ctxFor(userWith('a.read'))), {
      status: 'error',
      error: 'write tools require confirmation',
    });
    assert.equal(writePrepare.mock.callCount(), 0);
    assert.equal(writeCommit.mock.callCount(), 0);
  });

  it('applies guardResultForRule: salary redacted without employees.manage, kept with it', async () => {
    const redacted = await runTool('fake_person', {}, ctxFor(userWith('a.read')));
    assert.deepEqual(redacted, { status: 'ok', result: { name: 'Asha' } });
    const kept = await runTool('fake_person', {}, ctxFor(userWith('a.read', 'employees.manage')));
    assert.deepEqual(kept, { status: 'ok', result: { name: 'Asha', salaryRange: '10-20 LPA' } });
  });

  it('a composite may call another tool, which sees the caller access', async () => {
    const allowed = await runTool('fake_composite', {}, ctxFor(userWith('a.read')));
    assert.deepEqual(allowed.result.inner, { status: 'ok', result: { echo: { q: 'hi' }, depth: 2, requestId: 'r1' } });
    const denied = await runTool('fake_composite', {}, ctxFor(userWith()));
    assert.deepEqual(denied, { status: 'ok', result: { inner: { status: 'restricted' } } });
  });

  it('refuses beyond depth 2, so a self-calling tool stops', async () => {
    const out = await runTool('fake_loop', {}, ctxFor(userWith()));
    assert.equal(out.status, 'ok');
    assert.equal(out.result.inner.status, 'ok');
    const third = out.result.inner.result.inner;
    assert.equal(third.status, 'error');
    assert.match(third.error, /depth limit/);
  });
});

describe('compose runTools', () => {
  it('runs calls in parallel and returns statuses in call order', async () => {
    const out = await runTools(
      [
        { name: 'fake_echo', args: { q: 'a' } },
        { name: 'fake_slow', args: {}, timeoutMs: 20 },
        { name: 'nope', args: {} },
      ],
      ctxFor(userWith('a.read'))
    );
    assert.deepEqual(
      out.map((r) => r.status),
      ['ok', 'timeout', 'unknown']
    );
    assert.deepEqual(out[0].result.echo, { q: 'a' });
  });
});
