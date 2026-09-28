import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentInput,
  compactTurnItems,
  summarizeCalls,
  appendAgentLedger,
  readAgentLedger,
} from '../context.js';

const BASE_INSTRUCTIONS = 'You are Sage. Domain snippets here. Tool schemas sorted by name.';

describe('buildAgentInput — stable prefix', () => {
  it('returns the instructions string byte-identical for two different users / dates', () => {
    const out1 = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      roleNames: ['Administrator'],
      history: [],
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    const out2 = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Someone Else' },
      roleNames: ['Employee'],
      history: [],
      ledger: [],
      now: new Date('2027-01-01T00:00:00Z'),
    });
    assert.equal(out1.instructions, BASE_INSTRUCTIONS);
    assert.equal(out2.instructions, BASE_INSTRUCTIONS);
    assert.equal(out1.instructions, out2.instructions);
  });
});

describe('buildAgentInput — turn-context message', () => {
  it('includes today\'s date in the given timezone', () => {
    const now = new Date('2026-09-28T20:30:00Z'); // 02:00 IST next day, 16:30 EDT same day
    const kolkata = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history: [],
      ledger: [],
      now,
    });
    const newYork = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history: [],
      ledger: [],
      now,
      timezone: 'America/New_York',
    });
    assert.equal(kolkata.input[0].role, 'developer');
    assert.match(kolkata.input[0].content, /2026-09-29/);
    assert.match(newYork.input[0].content, /2026-09-28/);
  });

  it('includes the user\'s display name and the caller-supplied role names', () => {
    const withRoleNames = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      roleNames: ['Administrator', 'Employee'],
      history: [],
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    assert.match(withRoleNames.input[0].content, /Prakhar/);
    assert.match(withRoleNames.input[0].content, /Administrator \+ Employee/);

    const withNothing = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: {},
      history: [],
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    assert.doesNotThrow(() => withNothing.input[0].content);
    assert.match(withNothing.input[0].content, /role: User/);
  });

  it('never guesses a role from raw user.roleIds/user.role — falls back to "User" when roleNames is omitted', () => {
    // Real req.user.roleIds are unpopulated ObjectIds in production (no .name),
    // and a legacy user.role string must not be treated as a resolved name.
    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar', roleIds: ['64f1a2b3c4d5e6f7a8b9c0d1'], role: 'admin' },
      history: [],
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    assert.match(out.input[0].content, /Prakhar/);
    assert.match(out.input[0].content, /role: User/);
    assert.doesNotMatch(out.input[0].content, /admin/);
  });

  it('renders a "Previous tool calls" section from the ledger, most recent turn last', () => {
    const ledger = [
      { at: new Date('2026-09-27T10:00:00Z'), calls: [{ tool: 'count_jobs', args: { search: 'php' }, total: 4 }] },
      { at: new Date('2026-09-28T10:00:00Z'), calls: [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }] },
    ];
    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history: [],
      ledger,
      now: new Date('2026-09-28T10:00:00Z'),
    });
    const content = out.input[0].content;
    assert.match(content, /Previous tool calls/);
    const phpLine = 'count_jobs({"search":"php"}) → total 4';
    const mlLine = 'count_jobs({"search":"ml"}) → total 12';
    assert.ok(content.includes(phpLine), content);
    assert.ok(content.includes(mlLine), content);
    // most recent turn (ml) rendered after the older turn (php)
    assert.ok(content.indexOf(phpLine) < content.indexOf(mlLine));
  });

  it('renders a capped (already-stringified) ledger arg without double-encoding it', () => {
    // summarizeCalls' capArgs stores a truncated JSON *string* in place of an
    // oversized args object. renderLedgerLine must not JSON.stringify that
    // string again — doing so would wrap it in quotes and escape every `"`.
    const hugeArgs = { search: 'x'.repeat(500) };
    const entry = summarizeCalls([{ name: 'count_jobs', args: hugeArgs, output: { total: 7 } }]);
    assert.equal(typeof entry.calls[0].args, 'string', 'test fixture sanity: capArgs must have kicked in');

    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history: [],
      ledger: [entry],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    const content = out.input[0].content;
    assert.ok(content.includes('count_jobs('), content);
    assert.ok(content.includes('total 7'), content);
    assert.ok(!content.includes('\\"'), `expected no escaped quotes (double-encoding), got: ${content}`);
  });

  it('omits the ledger section entirely when there is no ledger history', () => {
    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history: [],
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    assert.doesNotMatch(out.input[0].content, /Previous tool calls/);
  });
});

describe('buildAgentInput — history trimming', () => {
  it('keeps only the last 6 turns, always keeping the final (unanswered) user message', () => {
    const history = [];
    for (let i = 1; i <= 7; i += 1) {
      history.push({ role: 'user', content: `u${i}` });
      history.push({ role: 'assistant', content: `a${i}` });
    }
    history.push({ role: 'user', content: 'u8' }); // current turn's query, no reply yet

    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history,
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });

    const rest = out.input.slice(1); // drop the developer turn-context message
    assert.deepEqual(rest.map((m) => m.content), [
      'u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'u6', 'a6', 'u7', 'a7', 'u8',
    ]);
    assert.equal(rest[rest.length - 1].role, 'user');
    assert.equal(rest[rest.length - 1].content, 'u8');
    for (const m of rest) {
      assert.deepEqual(Object.keys(m).sort(), ['content', 'role']);
    }
  });

  it('drops empty / non-string content but keeps the rest in order', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 42 },
      { role: 'user', content: 'final question' },
    ];
    const out = buildAgentInput({
      instructions: BASE_INSTRUCTIONS,
      user: { name: 'Prakhar' },
      history,
      ledger: [],
      now: new Date('2026-09-28T10:00:00Z'),
    });
    const rest = out.input.slice(1);
    assert.deepEqual(rest.map((m) => m.content), ['hello', 'follow up', 'final question']);
  });
});

describe('compactTurnItems', () => {
  const bigTotal = (n) => ({ total: n, jobs: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Job ${i}`.padEnd(40, 'x') })) });

  it('returns items unchanged when under budget', () => {
    const items = [
      { type: 'function_call', call_id: 'call_1', name: 'count_jobs', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ total: 12 }) },
    ];
    const result = compactTurnItems(items, 100000);
    assert.equal(result, items);
  });

  it('budgetChars <= 0 means no budget: items returned unchanged', () => {
    const items = [
      { type: 'function_call', call_id: 'call_1', name: 'count_jobs', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify(bigTotal(12)) },
    ];
    assert.equal(compactTurnItems(items, 0), items);
    assert.equal(compactTurnItems(items, -5), items);
  });

  it('compacts the oldest function_call_output first, keeping item count/order and call_ids', () => {
    const items = [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'call_1', name: 'count_jobs', arguments: '{"search":"ml"}' },
      { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify(bigTotal(12)) },
      { type: 'function_call', call_id: 'call_2', name: 'list_jobs', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: JSON.stringify(bigTotal(3)) },
      { type: 'message', role: 'assistant', content: 'here you go' },
    ];
    const fullLength = JSON.stringify(items).length;
    // Budget: below full size, but above the size once call_1's output alone is compacted.
    const afterFirstCompactSize = JSON.stringify([
      items[0], items[1],
      { ...items[2], output: JSON.stringify({ compacted: true, summary: 'count_jobs → total 12' }) },
      items[3], items[4], items[5],
    ]).length;
    const budget = afterFirstCompactSize + 5;
    assert.ok(budget < fullLength, 'test fixture sanity: budget must be below the uncompacted size');

    const result = compactTurnItems(items, budget);

    assert.equal(result.length, items.length);
    assert.equal(result[0], items[0]);
    assert.equal(result[1], items[1]);
    assert.equal(result[1].call_id, 'call_1');
    assert.equal(result[2].call_id, 'call_1');
    assert.deepEqual(JSON.parse(result[2].output), { compacted: true, summary: 'count_jobs → total 12' });
    // call_2's output is untouched — it was newer, so compaction left it alone.
    assert.equal(result[3], items[3]);
    assert.equal(result[4], items[4]);
    assert.equal(result[5], items[5]);
  });

  it('falls back to "(result omitted)" when the output has no total, and never drops/reorders items', () => {
    const items = [
      { type: 'function_call', call_id: 'call_1', name: 'do_thing', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ jobs: [] }) },
      { type: 'function_call', call_id: 'call_2', name: 'do_other', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: JSON.stringify({ jobs: [] }) },
    ];
    // Force compaction of everything by using a tiny budget.
    const result = compactTurnItems(items, 10);
    assert.equal(result.length, 4);
    assert.deepEqual(result.map((it) => it.call_id), ['call_1', 'call_1', 'call_2', 'call_2']);
    assert.deepEqual(JSON.parse(result[1].output), { compacted: true, summary: 'do_thing → (result omitted)' });
    assert.deepEqual(JSON.parse(result[3].output), { compacted: true, summary: 'do_other → (result omitted)' });
  });
});

describe('summarizeCalls', () => {
  it('derives total from output.total, falls back to output.jobs.length, else null', () => {
    const entry = summarizeCalls([
      { name: 'count_jobs', args: { search: 'ml' }, output: { total: 12 } },
      { name: 'list_jobs', args: { page: 1 }, output: { jobs: [1, 2, 3] } },
      { name: 'noop', args: {}, output: {} },
    ]);
    assert.ok(entry.at instanceof Date);
    assert.deepEqual(entry.calls, [
      { tool: 'count_jobs', args: { search: 'ml' }, total: 12 },
      { tool: 'list_jobs', args: { page: 1 }, total: 3 },
      { tool: 'noop', args: {}, total: null },
    ]);
  });

  it('caps very large args to ~300 chars instead of storing the full object', () => {
    const hugeArgs = { search: 'x'.repeat(500) };
    const entry = summarizeCalls([{ name: 'count_jobs', args: hugeArgs, output: { total: 1 } }]);
    const stored = entry.calls[0].args;
    if (typeof stored === 'string') {
      assert.ok(stored.length <= 320);
    } else {
      assert.ok(JSON.stringify(stored).length <= 320);
    }
  });
});

describe('readAgentLedger', () => {
  it('reads agentLedger off a memory doc, defaulting to []', () => {
    assert.deepEqual(readAgentLedger({ agentLedger: [1, 2] }), [1, 2]);
    assert.deepEqual(readAgentLedger({}), []);
    assert.deepEqual(readAgentLedger(null), []);
    assert.deepEqual(readAgentLedger(undefined), []);
  });
});

describe('appendAgentLedger', () => {
  it('calls findOneAndUpdate with the (userId, adminId) filter, $push/$each/$slice -6, and upsert', async () => {
    const calls = [];
    const fakeModel = {
      findOneAndUpdate: async (filter, update, options) => {
        calls.push({ filter, update, options });
        return { _id: 'doc1' };
      },
    };
    const entry = { at: new Date(), calls: [{ tool: 'count_jobs', args: { search: 'ml' }, total: 12 }] };
    await appendAgentLedger({ userId: 'u1', adminId: 'a1', entry, ConversationMemoryModel: fakeModel });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filter, { userId: 'u1', adminId: 'a1' });
    assert.deepEqual(calls[0].update, { $push: { agentLedger: { $each: [entry], $slice: -6 } } });
    assert.deepEqual(calls[0].options, { upsert: true });
  });
});
