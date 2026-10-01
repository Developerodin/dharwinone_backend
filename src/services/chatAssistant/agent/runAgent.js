// Sage's tool-calling agent loop (architecture.md §3, §7a, §7b).
//
// Contract: returns an answer envelope, or null. Null means the turn was not
// answered — handoff, repeated bad args, empty output, an unchecked number, the
// deadline, any thrown error — and `onOutcome` names which; the caller
// (agent/gate.js) replies with a fixed message. Sage must never go dark.
//
// No DB writes here: the caller (entry gate) persists `ledgerEntry`.

import config from '../../../config/config.js';
import logger from '../../../config/logger.js';
import { step as llmStep } from './llm.js';
import { getAgentTools as defaultGetAgentTools, FIND_TOOLS_NAME } from './toolRegistry.js';
import { buildAgentInput, compactTurnItems, summarizeCalls, readAgentLedger } from './context.js';
import Role from '../../../models/role.model.js';
import { enforceCounts } from '../responseValidator.js';

/**
 * The viewer's active role NAMES (all of them, not a collapsed tier) for the turn
 * context — the model introduces the speaker by their real roles.
 * @param {{ roleIds?:string[], platformSuperUser?:boolean }|null|undefined} user
 * @returns {Promise<string[]>}
 */
async function defaultResolveViewerRoleNames(user) {
  if (!user) return [];
  const roleIds = user.roleIds || [];
  if (!roleIds.length) return user.platformSuperUser ? ['Administrator'] : [];
  try {
    const docs = await Role.find({ _id: { $in: roleIds }, status: 'active' })
      .select('name')
      .lean();
    return docs.map((r) => r.name).filter(Boolean);
  } catch {
    return [];
  }
}

// The model can emit dozens of parallel calls when its tools don't fit the
// question (task-2-report, check 3). Only the first MAX_CALLS_PER_STEP run; the
// rest still get an output, because every function_call needs a
// function_call_output or the API rejects the next request.
const MAX_CALLS_PER_STEP = 8;
const TOO_MANY_CALLS_OUTPUT = JSON.stringify({ error: 'too many calls in one step' });
const FIND_TOOLS_KEEP = [FIND_TOOLS_NAME];

// Same tool failing this many times in one turn = the model isn't converging.
const MAX_FAILURES_PER_TOOL = 2;

// Domain-neutral; domain guidance comes from the registry. Part of the stable
// prefix — nothing per-user or time-varying belongs here.
export const BASE_INSTRUCTIONS = [
  "You are Sage, the assistant inside this company's HR and recruiting platform.",
  'Facts about the company data (counts, jobs, people, statuses) come only from the tools — never from memory.',
  'Only general knowledge that is the same at every company — what a generic term, acronym or tech stack means (e.g. "MERN") — may be answered directly without tools.',
  'Anything about THIS company — its policies, people, numbers or data (e.g. "our notice period", "how many employees do we have") — is never general knowledge: use a tool, or call `handoff` if none fits.',
  'Every number in your reply must come from a tool result returned in THIS turn. Earlier replies and "Previous tool calls" totals are context only: for a follow-up question, call the tool again with the changed arguments — never reuse an old number.',
  'Every number in your reply names what it counts and its status scope, taken from the tool result\'s `measure` (e.g. "23 accounts with the Candidate role, all statuses" vs "20 candidate profiles, active and pending accounts"). Never put counts of different measures in one sentence without saying they measure different things.',
  'When the user questions a number ("are you sure", "I mean all of them"), do not repeat it: re-check with a different measure or status scope (accounts vs profiles, active vs all) and explain why the numbers differ.',
  'You may call several tools at once when the question needs them.',
  'If a tool returns an error, fix the arguments and try again. If a result says truncated, tell the user and suggest narrowing the filters.',
  'If no available tool fits the question, call `handoff` with a short reason instead of answering.',
  'A write tool only drafts. Tell the user what the draft will do and that they must press Confirm. Never say it is done.',
  'Greetings, thanks and small talk ("hi", "thanks"): reply briefly and warmly with no tool call, and offer help. Never put a number in such a reply.',
  'Reply in plain, concise markdown.',
].join('\n');

function parseArgsForLedger(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** `current` plus any `added` schema whose name it lacks; the same reference when nothing is new. */
function mergeSchemas(current, added) {
  const have = new Set(current.map((s) => s.name));
  const fresh = added.filter((s) => !have.has(s.name));
  return fresh.length ? [...current, ...fresh].sort((a, b) => a.name.localeCompare(b.name)) : current;
}

/** Domains of the tools called in the last ledger entry (legacy handoff markers carry no calls). */
function ledgerDomains(ledger, registry) {
  const calls = Array.isArray(ledger) ? ledger.at(-1)?.calls : null;
  if (!Array.isArray(calls)) return [];
  return [...new Set(calls.map((c) => registry.domainOfTool(c?.tool)).filter(Boolean))];
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cachedTokens += usage.input_tokens_details?.cached_tokens ?? 0;
}

/**
 * Merge count facts from every rendered call this turn. All calls of one tool
 * share a label (e.g. 'jobs'), and enforceCounts rewrites EVERY "N <label>" in
 * the reply to the fact's total — so two calls with different totals for the
 * same label ("9 internships, 4 contract jobs") must not be enforced at all,
 * or the first number gets overwritten with the second.
 */
function mergeCountFacts(factsList) {
  const byKey = new Map();
  for (const facts of factsList) {
    for (const fact of facts?.counts ?? []) {
      if (typeof fact?.total !== 'number') continue;
      const key = fact.role ? `role:${String(fact.role).toLowerCase()}` : `label:${fact.label}`;
      if (!byKey.has(key)) byKey.set(key, { fact, totals: new Set() });
      byKey.get(key).totals.add(fact.total);
    }
  }
  const counts = [...byKey.values()].filter((g) => g.totals.size === 1).map((g) => g.fact);
  return { counts, primary: null };
}

/**
 * @param {object} args
 * @param {{responses:{create:Function}}} args.client OpenAI client
 * @param {object} args.user req.user
 * @param {Array<{role:string, content:string}>} args.history this request's messages (current question last)
 * @param {{agentLedger?:Array}|null} args.memDoc ConversationMemory doc (read-only here)
 * @param {string} [args.requestId]
 * @param {(outcome:string) => void} [args.onOutcome] called once with the turn's outcome
 *   ('answer', 'handoff', 'untooled_number', 'empty', 'deadline', 'repeated_tool_failure', 'error')
 * @param {{step?:Function, getAgentTools?:Function, resolveViewerRoleNames?:Function, now?:Function}} [args.deps]
 * @returns {Promise<null | {reply:string, blocks:Array, meta:{steps:number, toolCalls:string[], ms:number}, ledgerEntry:object}>}
 */
/** Call args as a key-order-independent string, so `{a,b}` and `{b,a}` are the same call. */
function stableArgs(raw) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw ?? {};
  } catch {
    return String(raw);
  }
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
        : v;
  return JSON.stringify(sort(value));
}

export async function runAgent({ client, user, history, memDoc, requestId, onOutcome = () => {}, deps = {} }) {
  const {
    step = llmStep,
    getAgentTools = defaultGetAgentTools,
    resolveViewerRoleNames = defaultResolveViewerRoleNames,
    now = () => new Date(),
  } = deps;

  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const executed = []; // { name, args, ok, result }
  let steps = 0;
  let outcome = 'error';
  let lazy = false;
  let activeSchemas = [];

  try {
    const registry = await getAgentTools(user);
    const isFindTools = (name) => !!registry.isFindTools?.(name);
    // A write tool only drafts. The model sometimes repeats the exact same call (in parallel or a step
    // later); each run would store another SageAction and show another confirm card for one action.
    // So an identical call (same tool, same args in any key order) reuses the first call's draft.
    // Reads still run again: only a result with `draft: true` is reused.
    const firstCalls = new Map();
    const executeOnce = (c) => {
      const key = `${c.name}:${stableArgs(c.arguments)}`;
      const run = () => registry.execute(c.name, c.arguments, { requestId });
      const first = firstCalls.get(key);
      if (!first) {
        const p = run();
        firstCalls.set(key, p);
        return p;
      }
      return first.then((r) => (r?.ok && r.result?.draft ? r : run()), run);
    };
    lazy = !!registry.lazy;
    activeSchemas = registry.schemas;
    const roleNames = await resolveViewerRoleNames(user);
    const ledger = readAgentLedger(memDoc);

    // Lazy registry: a follow-up usually stays in the last turn's domains, so load them up front.
    let preloaded = null;
    if (lazy) {
      const domains = ledgerDomains(ledger, registry);
      if (domains.length) {
        preloaded = registry.loadDomains(domains);
        activeSchemas = mergeSchemas(activeSchemas, preloaded.schemas);
      }
    }

    const built = buildAgentInput({
      instructions: `${BASE_INSTRUCTIONS}\n\n${registry.instructions}`,
      user,
      roleNames,
      history,
      ledger,
      now: now(),
      preloaded,
    });
    const { instructions } = built;
    let { input } = built;

    /** One find_tools call → its output; loaded schemas join the active set for the next step. */
    const runFindTools = async (rawArgs) => {
      const parsed = registry.parseFindToolsArgs(rawArgs);
      if (parsed.error) return { ok: false, error: parsed.error };
      const { schemas, instructions: domainInstructions, loaded } = registry.loadDomains(parsed.domains);
      activeSchemas = mergeSchemas(activeSchemas, schemas);
      return { ok: true, result: { loaded, instructions: domainInstructions } };
    };
    const { maxSteps, inputBudget, stepTimeoutMs, turnTimeoutMs } = config.chatbot.agent;

    // Turn deadline: a slow provider must not delay the fallback reply. Each step
    // gets at most the time left, so the whole turn stays near turnTimeoutMs
    // (plus at most one tool batch, bounded by toolTimeoutMs).
    const runStep = async (toolChoice) => {
      const remaining = turnTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        outcome = 'deadline';
        throw new Error('turn deadline exceeded');
      }
      steps += 1;
      const res = await step({
        client,
        instructions,
        input,
        tools: activeSchemas,
        toolChoice,
        timeoutMs: Math.min(stepTimeoutMs, remaining),
      });
      addUsage(usage, res.usage);
      return res;
    };

    const failuresByTool = new Map();
    let text = null;
    let freeStepUsed = false;

    for (let i = 0; i < maxSteps && text === null; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runStep('auto');

      if (!res.toolCalls.length) {
        text = res.text;
        if (!text.trim()) {
          // Empty (or truncated) output is a failure, not an answer: one text-only
          // retry on the SAME input. Its outputItems are not replayed — a lone
          // reasoning item without its following item makes the API 400.
          // eslint-disable-next-line no-await-in-loop
          text = (await runStep('none')).text;
        }
        break;
      }

      if (res.toolCalls.some((c) => registry.isHandoff(c.name))) {
        outcome = 'handoff';
        return null;
      }

      // Loading tools is not progress on the answer: one find_tools-only step per turn is free.
      if (!freeStepUsed && res.toolCalls.every((c) => isFindTools(c.name))) {
        freeStepUsed = true;
        i -= 1;
      }

      const allowed = res.toolCalls.slice(0, MAX_CALLS_PER_STEP);
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled(
        allowed.map((c) => (isFindTools(c.name) ? runFindTools(c.arguments) : executeOnce(c)))
      );

      // A tool counts at most one failure per step: parallel failures of one tool
      // in the same step must reach the model before the turn is abandoned.
      const failedThisStep = new Set();
      const outputs = res.toolCalls.map((c, idx) => {
        if (idx >= allowed.length) {
          return { type: 'function_call_output', call_id: c.callId, output: TOO_MANY_CALLS_OUTPUT };
        }
        const s = settled[idx];
        const r = s.status === 'fulfilled' ? s.value : { ok: false, error: s.reason?.message || String(s.reason) };
        executed.push({ name: c.name, args: parseArgsForLedger(c.arguments), ok: !!r.ok, result: r.result });
        if (!r.ok) failedThisStep.add(c.name);
        const output = JSON.stringify(r.ok ? r.result : { error: r.error });
        return { type: 'function_call_output', call_id: c.callId, output };
      });
      for (const name of failedThisStep) failuresByTool.set(name, (failuresByTool.get(name) ?? 0) + 1);

      if ([...failuresByTool.values()].some((n) => n >= MAX_FAILURES_PER_TOOL)) {
        outcome = 'repeated_tool_failure';
        return null;
      }

      // Ceiling: compaction shrinks the OLDEST outputs first, so under a very long
      // history it can also shrink this step's fresh outputs; upgrade = exempt the
      // latest step's outputs in compactTurnItems.
      // find_tools outputs carry the loaded domains' instructions; the schemas stay loaded, so the
      // guidance for using them must not be compacted away.
      input = compactTurnItems([...input, ...res.outputItems, ...outputs], inputBudget, { keepTools: FIND_TOOLS_KEEP });
    }

    if (text === null) {
      // Step cap hit while still calling tools: answer from what was gathered.
      text = (await runStep('none')).text;
    }
    if (!text || !text.trim()) {
      outcome = 'empty';
      return null;
    }
    // enforceCounts can only correct numbers against facts from this turn's tools.
    // With no successful tool call there are no facts, so a number in the reply
    // is unchecked (e.g. a from-memory "our notice period is 30 days") — the caller
    // sends a fixed reply instead. Digit-free replies (definitions) still ship.
    // find_tools only loads tools; it returns no company data, so it never counts as the answer.
    const successful = executed.filter((c) => c.ok && !isFindTools(c.name));
    if (!successful.length && /\d/.test(text)) {
      outcome = 'untooled_number';
      return null;
    }

    let blocks = [];
    const confirmBlocks = [];
    const factsList = [];
    for (const call of successful) {
      const rendered = registry.render(call.name, call.result);
      if (!rendered) continue;
      // A draft's confirm block is the only way to run it, so it is kept, never replaced.
      const confirms = (rendered.blocks ?? []).filter((b) => b?.type === 'confirm');
      if (confirms.length) {
        for (const b of confirms) if (!confirmBlocks.some((x) => x.key === b.key)) confirmBlocks.push(b);
      }
      // Only a render WITH blocks replaces them: a plain count renders `blocks: []`
      // and must not wipe a list shown by an earlier call ("how many ML jobs, show them").
      else if (rendered.blocks?.length) blocks = rendered.blocks;
      if (rendered.facts) factsList.push(rendered.facts);
    }
    blocks = [...blocks, ...confirmBlocks];
    const facts = mergeCountFacts(factsList);
    const reply = facts.counts.length ? enforceCounts(text, facts).reply : text;

    outcome = 'answer';
    return {
      reply,
      blocks,
      meta: { steps, toolCalls: executed.map((c) => c.name), ms: Date.now() - startedAt },
      ledgerEntry: summarizeCalls(successful.map((c) => ({ name: c.name, args: c.args, output: c.result }))),
    };
  } catch (err) {
    logger.warn(`[runAgent] turn failed: ${JSON.stringify({ requestId, error: err?.message || String(err) })}`);
    return null;
  } finally {
    onOutcome(outcome);
    logger.info(
      `[runAgent] ${JSON.stringify({
        requestId,
        outcome,
        steps,
        lazy,
        toolsOffered: activeSchemas.length,
        tools: executed.map((c) => c.name),
        ms: Date.now() - startedAt,
        usage,
      })}`
    );
  }
}
