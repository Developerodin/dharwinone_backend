#!/usr/bin/env node
// Tool-pick eval runner for Sage's agent loop (architecture.md §6).
//
// Uses the REAL tool registry schemas + REAL runAgent + REAL llm.step against
// the live OpenAI model, but replaces tool EXECUTION with fake, canned
// results — no MongoDB access anywhere in this script. Scores each case's
// recorded tool calls against cases.json's `expect`, then reports accuracy
// and latency. Report-only by default (--min 0 means "never fail the run");
// pass --min <pct> to exit 1 when accuracy drops below it.
//
// Usage:
//   node scripts/sage-agent-evals.js
//   node scripts/sage-agent-evals.js --case count-plain-react
//   node scripts/sage-agent-evals.js --min 80

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

import config from '../src/config/config.js';
import { runAgent } from '../src/services/chatAssistant/agent/runAgent.js';
import { getAgentTools as realGetAgentTools } from '../src/services/chatAssistant/agent/toolRegistry.js';
import { step as realLlmStep } from '../src/services/chatAssistant/agent/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.resolve(__dirname, '../src/services/chatAssistant/agent/__evals__/cases.json');

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { caseId: null, min: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') out.caseId = argv[++i];
    else if (argv[i] === '--min') out.min = Number(argv[++i]);
  }
  return out;
}

// ─── Arg matching: partial, case-insensitive on strings ────────────────────

function normalizeVal(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

/** True when every field of `expected` is present with an equal value in `actual` (deep, partial). */
function partialMatch(expected, actual) {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    const normActual = actual.map(normalizeVal);
    return expected.map(normalizeVal).every((e) => normActual.includes(e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => partialMatch(v, actual[k]));
  }
  return normalizeVal(expected) === normalizeVal(actual);
}

// ─── Expectation scoring ────────────────────────────────────────────────────

const VALID_GROUP_BY = ['jobType', 'status', 'experienceLevel', 'company', 'city', 'country', 'industry', 'origin'];

const RULES = {
  // "jobs in each category" etc.: whatever the model answers with, it must not
  // hallucinate a groupBy value outside count_jobs' own enum. No call, or a
  // call with no groupBy, or a handoff all pass; an invented groupBy fails.
  no_invalid_groupby: (calls) =>
    !calls.some((c) => c.name === 'count_jobs' && c.args?.groupBy && !VALID_GROUP_BY.includes(c.args.groupBy)),
};

function sameNameSet(names, expected) {
  const a = [...new Set(names)].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const SEARCHABLE_JOB_TOOLS = ['count_jobs', 'list_jobs', 'rank_jobs_by_salary', 'get_job'];

/**
 * True if any job-tool call leaked a person's name into a job query — e.g. the
 * model searching jobs for "John" instead of handing off a people question.
 * Checks filters.search (string or array) on count/list/rank, and title on get_job.
 */
function containsSearchTerm(calls, term) {
  const needle = term.toLowerCase();
  return calls.some((c) => {
    if (!SEARCHABLE_JOB_TOOLS.includes(c.name)) return false;
    const candidates = [c.args?.filters?.search, c.args?.title].flatMap((v) => (Array.isArray(v) ? v : [v]));
    return candidates.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
  });
}

/** @param {object} expect one case's `expect`, or one `anyOf` alternative */
function evaluateExpect(expect, ctx) {
  if (expect.anyOf) return expect.anyOf.some((alt) => evaluateExpect(alt, ctx));
  if (expect.rule) return RULES[expect.rule](ctx.calls);
  if (expect.handoff) {
    if (!ctx.handoffCalled) return false;
    if (expect.forbidSearchTerm && containsSearchTerm(ctx.calls, expect.forbidSearchTerm)) return false;
    return true;
  }

  const toolCalls = ctx.calls.filter((c) => c.name !== 'handoff');
  if (expect.tools && !sameNameSet(toolCalls.map((c) => c.name), expect.tools)) return false;

  if (expect.args) {
    for (const [tool, spec] of Object.entries(expect.args)) {
      // A spec can be one partial-match object, or an array where EACH entry
      // must be satisfied by some call to that tool (e.g. two count_jobs
      // calls with different jobType filters).
      const specs = Array.isArray(spec) ? spec : [spec];
      const callsForTool = toolCalls.filter((c) => c.name === tool);
      if (!specs.every((s) => callsForTool.some((c) => partialMatch(s, c.args)))) return false;
    }
  }
  return true;
}

// ─── Fake user (jobs.read only, no DB) ──────────────────────────────────────

const FAKE_USER = Object.freeze({
  id: 'eval-user-0000000000000001',
  name: 'Eval User',
  authContext: { permissions: new Set(['jobs.read']) },
});

function jobRow(i, overrides = {}) {
  return {
    jobId: `eval-job-${i}`,
    jobUrl: `/jobs/eval-job-${i}`,
    title: `Eval Job ${i}`,
    organisation: { name: 'Acme Corp' },
    jobType: 'Full-time',
    location: 'Remote',
    status: 'Active',
    experienceLevel: 'Mid Level',
    salaryRange: null,
    skillTags: [],
    vacancies: 1,
    ...overrides,
  };
}

/**
 * A plausible fake result per tool name. Shape matches what the real tool
 * returns closely enough for runAgent's ledger (`total`) to work; content is
 * otherwise inert — this eval measures tool PICKS, not rendering or numbers.
 */
function cannedResult(name, args) {
  switch (name) {
    case 'count_jobs': {
      if (args?.groupBy) {
        return {
          total: 7,
          groupBy: args.groupBy,
          groups: [
            { value: 'alpha', count: 4 },
            { value: 'beta', count: 3 },
          ],
          filtersApplied: args.filters ?? {},
        };
      }
      return { total: 7, filtersApplied: args?.filters ?? {} };
    }
    case 'list_jobs':
      return { total: 3, jobs: [jobRow(1), jobRow(2), jobRow(3)], filtersApplied: args?.filters ?? {} };
    case 'rank_jobs_by_salary':
      return {
        total: 5,
        direction: args?.direction ?? 'desc',
        jobs: [
          jobRow(1, { salaryRange: { min: 2000000, max: 2200000 } }),
          jobRow(2, { salaryRange: { min: 1800000, max: 2000000 } }),
        ],
      };
    case 'get_job':
      return { job: jobRow(1, { title: args?.title || 'Eval Job', jobDescription: 'Eval-only canned description.' }) };
    default:
      return { handoff: true };
  }
}

function parseArgsJson(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Wrap the REAL registry: keeps its real schemas/instructions/isHandoff (so
 * the live model sees the exact tool contracts it sees in prod), but replaces
 * `execute` with a fake that never touches Mongo, and `render` with a no-op
 * (rendering fidelity isn't what this eval measures).
 */
function wrapRegistryForEval(real) {
  return {
    schemas: real.schemas,
    instructions: real.instructions,
    isHandoff: real.isHandoff,
    render: () => null,
    async execute(name, rawArgs) {
      const args = parseArgsJson(rawArgs);
      return { ok: true, result: cannedResult(name, args) };
    },
  };
}

/**
 * Builds runAgent `deps` for one case run: `getAgentTools` is the real
 * registry wrapped per above; `step` is the real `llm.step` (hits the live
 * model) instrumented to record every tool call the model attempts —
 * including `handoff`, which runAgent short-circuits to null before it ever
 * reaches `registry.execute` — plus per-step token usage.
 */
function buildInstrumentedDeps() {
  const calls = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  async function getAgentTools(user, opts) {
    const real = await realGetAgentTools(user, opts);
    return wrapRegistryForEval(real);
  }

  async function step(req) {
    const res = await realLlmStep(req);
    for (const c of res.toolCalls) calls.push({ name: c.name, args: parseArgsJson(c.arguments) });
    if (res.usage) {
      usage.inputTokens += res.usage.input_tokens ?? 0;
      usage.outputTokens += res.usage.output_tokens ?? 0;
    }
    return res;
  }

  return { deps: { getAgentTools, step, resolveViewerRoleNames: async () => ['Administrator'] }, calls, usage };
}

// ─── Case runner ────────────────────────────────────────────────────────────

function buildMemDoc(ledger) {
  if (!ledger) return null;
  return { agentLedger: ledger.map((entry) => ({ at: new Date(), calls: entry.calls })) };
}

async function runCase(client, testCase) {
  const history = [...(testCase.history ?? []), { role: 'user', content: testCase.question }];
  const memDoc = buildMemDoc(testCase.ledger);
  const { deps, calls, usage } = buildInstrumentedDeps();

  const startedAt = Date.now();
  let errored = null;
  try {
    await runAgent({ client, user: FAKE_USER, history, memDoc, requestId: `eval-${testCase.id}`, deps });
  } catch (err) {
    errored = err?.message || String(err);
  }
  const ms = Date.now() - startedAt;

  const handoffCalled = calls.some((c) => c.name === 'handoff');
  const pass = !errored && evaluateExpect(testCase.expect, { calls, handoffCalled });

  return { id: testCase.id, pass, ms, calls, handoffCalled, errored, usage };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function percentile(sortedMs, p) {
  if (!sortedMs.length) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function formatCall(c) {
  return `${c.name}(${JSON.stringify(c.args)})`;
}

async function main() {
  const { caseId, min } = parseArgs(process.argv.slice(2));
  const allCases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = caseId ? allCases.filter((c) => c.id === caseId) : allCases;
  if (!cases.length) {
    console.error(caseId ? `No case with id '${caseId}'` : 'No cases found.');
    process.exitCode = 1;
    return;
  }

  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const rows = [];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runCase(client, testCase);
    rows.push(outcome);
    const status = outcome.pass ? 'PASS' : 'FAIL';
    const callsText = outcome.calls.map(formatCall).join(', ') || '(no tool calls)';
    console.log(`[${status}] ${outcome.id} (${outcome.ms}ms) — ${callsText}`);
    if (outcome.errored) console.log(`  error: ${outcome.errored}`);
  }

  const passCount = rows.filter((r) => r.pass).length;
  const accuracy = (100 * passCount) / rows.length;
  const msSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const totalTokens = rows.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.outputTokens, 0);

  console.log('');
  console.log(`accuracy: ${passCount}/${rows.length} (${accuracy.toFixed(1)}%)`);
  console.log(`latency:  p50=${percentile(msSorted, 50)}ms p95=${percentile(msSorted, 95)}ms`);
  console.log(`tokens:   ${totalTokens} (input+output, summed across every model step)`);

  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    console.log('');
    console.log('Failed cases:');
    for (const r of failed) {
      const callsText = r.calls.map(formatCall).join(', ') || '(no tool calls)';
      console.log(`  - ${r.id}: ${callsText}${r.errored ? ` [error: ${r.errored}]` : ''}`);
    }
  }

  if (accuracy < min) {
    console.error(`\naccuracy ${accuracy.toFixed(1)}% is below --min ${min}%`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
