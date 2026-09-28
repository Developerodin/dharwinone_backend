# Sage's agent loop

## What this is

Sage (the chat assistant) answers migrated domains through a tool-calling loop on
OpenAI's Responses API: the model picks one or more tools, the tools query the
real service layer, and the model writes the final reply from the results. Domains
that haven't migrated yet — and any turn the loop can't handle — fall back to the
legacy deterministic pipeline in `chatAssistant.service.js`. The loop is **off by default**:
a host must explicitly set `CHATBOT_AGENT=true` to enable it; unset or `false` runs today's
legacy pipeline only, with no other changes.

## Request flow

1. `chatAssistant.service.js` first checks for a pending person/job/title pick (e.g.
   `readPending`'s person-disambiguation state) — an open pick always outranks the agent
   and every other routing path, so a bare "1" in reply to "did you mean X or Y?" never
   reaches the loop. Only once nothing is pending does it call `isAgentTurn(lastUserMsg,
   memDoc)` (`agent/gate.js`) — a cheap noun/recency check, not a real router. True → try
   the agent this turn.
2. `tryAgentRoute` calls `runAgent(...)` (`agent/runAgent.js`).
3. `runAgent` builds the tool list with `getAgentTools(user)` (`agent/toolRegistry.js`),
   permission-filtered so the model never sees a tool the user can't call.
4. `runAgent` loops `llm.step(...)` (`agent/llm.js`, the OpenAI Responses API) up to
   `CHATBOT_AGENT_MAX_STEPS` times: each step may return tool calls, which the registry's
   `execute(name, args)` runs, or a final text answer.
5. Successful tool results are rendered (`tool.render(result)` → `{ blocks, facts }`),
   the facts are merged and passed to `enforceCounts` so every number in the reply traces
   back to a tool result from this turn.
6. `runAgent` returns `{ reply, blocks, meta, ledgerEntry }`; the **caller** persists
   `ledgerEntry` onto `ConversationMemory.agentLedger` via `appendAgentLedger` — `runAgent`
   itself never writes to the DB.
7. Anything that isn't a clean answer — the model calling `handoff`, a thrown error, an
   empty final reply — makes `runAgent` return `null`, and the caller falls through to the
   legacy pipeline. Sage never goes dark because of the agent.

```
service.js --isAgentTurn--> runAgent --getAgentTools--> llm.step (loop) --tool calls--> registry.execute
    ^                                                                                          |
    |<--------------------------- null (handoff/error/empty) ---------------------------------|
    |
    +--> legacy pipeline (fallback)
```

## How to add a tool

This is the part that keeps adding the 41st tool as cheap as the 5th. Follow the
`jobs` domain (`agent/tools/jobs/`) as the reference.

### 1. Write the tool file

Create `agent/tools/<domain>/<name>.tool.js`:

```js
import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { MY_DOMAIN_ACCESS, myDomainScope } from './common.js';

export default defineTool({
  name: 'count_widgets',           // must match /^[a-z][a-z0-9_]{2,63}$/, unique across ALL domains
  domain: 'widgets',               // groups instructions + schemas; drives §7's find_tools upgrade later
  kind: 'read',                    // 'read' runs in the loop; 'write' is refused by the loop (see below)
  description: 'Count widgets the user can see. Use for "how many widgets…".', // the MODEL reads this — be specific about when to call it
  input: Joi.object({
    filters: Joi.object({ search: Joi.string().min(1) }),
  }),
  // { anyOf: [...] } (>=1 permission string) or { note: '...' } when a handler
  // already enforces its own check — same shape as toolAccess.js TOOL_ACCESS entries.
  access: { anyOf: ['widgets.read'] },
  async execute({ filters } = {}, ctx) {
    // ctx = { user, requestId, deps } — no chat objects (registry.js is chat-agnostic).
    const { Widget, visibilityFilter } = await myDomainScope(ctx);
    const match = { ...filters, ...visibilityFilter }; // AND the page's visibility filter — never trust filters alone
    return { total: await Widget.countDocuments(match) };
  },
  render(result) {
    // Optional. `facts.counts[]` entries are `{ kind, label, total }` — enforceCounts
    // rewrites every "N <label>" in the reply to `total`. Skip `facts` for a
    // per-group breakdown (rewriting each group's number to the overall total is wrong).
    return { blocks: [], facts: { counts: [{ kind: 'count_widgets', label: 'widgets', total: result.total }] } };
  },
});
```

Notes on each field, from what `defineTool.js` actually enforces (a bad tool throws at
**boot**, not mid-chat):
- **`input` (Joi) is the model-facing schema too.** `toJsonSchema.js` converts it once at
  load; it only supports the subset agent tools use — `object` (nested/required), `string`
  (`min`/`max`), `number`/`integer` (`min`/`max`), `boolean`, `array` (single item schema,
  `max`), `.valid(...)` as enum, `alternatives().try(...)` as `anyOf`, `.description()`,
  `.default()`, and a narrow `.allow(null)` on a plain-or-enum scalar. Anything else (`when`,
  pattern keys, unsupported rules) throws `Unsupported Joi feature '<x>' at <path>` — no
  silent drift between what Joi validates and what the model sees. String `.min()`/`.max()`
  are the only string transforms supported; don't reach for `.trim()`/`.lowercase()` etc.
  here — do that in `execute`.
- **Reuse a REST route's schema where one exists.** If the tool mirrors a portal GET page
  (e.g. jobs mirrors the ATS Jobs page), pull individual keys from that route's Joi object
  in `src/validations/*.validation.js` (see `agent/tools/jobs/filters.js`'s `page(key)`
  helper) so the chat accepts exactly what the page accepts. One source, no drift.
- **`access`** is `{ anyOf: [...] }` or `{ note: '...' }` (+ optional `rowScope: 'person'`) —
  identical semantics to a `toolAccess.js` `TOOL_ACCESS` entry; it replaces that entry for
  agent tools, evaluated by `checkAccessRule`/`guardResultForRule` (extracted from
  `checkToolAccess`/`guardToolResult`, same behavior).
- **`execute` must call the SERVICE layer**, not raw Mongo, when a service function exists —
  same business rules the REST controller uses.
- **`execute` must AND the page's visibility filter into every query**, and **must fail
  closed without a user id** — see `agent/tools/jobs/common.js`'s `jobScope(ctx)`: it throws
  if `ctx.user` has no id, because the visibility-filter builder returns `{}` (unrestricted)
  with no user id, and silently widening visibility on a missing id would be worse than
  erroring. New domains should follow the same `<domain>Scope(ctx)` pattern in their own
  `common.js`.
- **`render(result)` is optional.** Return `{ blocks, facts }` (facts optional). `facts.counts`
  entries are `{ kind, label, total }`. The multi-count merge rule (`runAgent.js`'s
  `mergeCountFacts`): when several tool calls in one turn report the same `label` (or the
  same `role`, if the fact carries one) with **different** totals — "9 internships, 4
  contract jobs" — neither gets enforced, because rewriting both "N `<label>`" phrases to a
  single total would corrupt one of them. Only give a fact the same label/role as another
  call in the turn when they really should share one number.

### 2. Register it

Add the tool to its domain's `agent/tools/<domain>/index.js`:

```js
export default { domain: 'widgets', instructions: '<plain-text guidance for this domain>', tools: [countWidgets] };
```

New domain → add one line to `agent/tools/index.js`'s array (see how it already lists `jobs`).

### 3. Add an eval case

`agent/__evals__/cases.json` holds question → expected tool + key args pairs, one array of
cases like:

```json
{ "id": "count-widgets-plain", "question": "how many widgets are there?",
  "expect": { "tools": ["count_widgets"], "args": { "count_widgets": { "filters": { "search": "widgets" } } } } }
```

`scripts/sage-agent-evals.js` (`npm run eval:sage-agent`) runs these against the **live**
model with the real registry and real loop, but fake tool executors (no DB), and reports
tool-pick accuracy + latency. Add at least one case for every new tool. Run it before
merging tool changes — it costs real tokens, so it isn't in unit test CI.

### 4. Register the test file (3-step trap)

A new `*.test.js` under `agent/__tests__/` or `agent/tools/<domain>/__tests__/` is already
covered by `package.json`'s `test:entity-query` glob (`agent/__tests__/*.test.js` and
`agent/tools/*/__tests__/*.test.js`) — but it still needs to be committed, which this repo's
tooling only does for files explicitly allow-listed:
1. Add a `!` line for the new test file (and its `__tests__/` dir, if new) to `.gitignore`
   under the "Sage agent loop" section.
2. Add its path to `scripts/test-manifest.json`.
3. Confirm it's under one of the two globs above in `package.json` (`test:entity-query`) —
   new domain directories already match `agent/tools/*/__tests__/*.test.js`.

See memory `project_backend_tests_not_versioned` for why this is 3 steps, not 1.

### 5. Widen the gate for a new domain

`agent/gate.js`'s `isAgentTurn` only recognizes job nouns today (Phase 1). A new domain's
questions won't reach the loop until its nouns are added to that check (or the user's last
turn was a recent agent turn — see `hasRecentAgentTurn`).

## Rules that keep it safe

- **RBAC is checked twice.** `getAgentTools` hides tools the user can't call (the model
  never sees them); `registry.execute` re-checks access on every call regardless, because
  the model can still name a tool it was never shown.
- **Numbers only come from this turn's tools.** `runAgent` merges `render()`'s `facts` and
  runs `enforceCounts` on the final text — a number the model invents from memory gets
  overwritten.
- **Results are size-capped, but only at the top level.** The registry's `shrinkToFit`
  (`MAX_RESULT_CHARS = 20000`) only shrinks the largest top-level **array** property,
  tagging `truncated: true`. A single large scalar field (e.g. `get_job`'s job description)
  is not touched by that cap — bound it yourself in the tool, the way `get_job.tool.js`'s
  `boundDescription` truncates at `MAX_DESCRIPTION_CHARS`.
- **Write tools are refused by the loop.** `kind: 'write'` tools are a contract for later:
  `registry.execute` returns an error ("write tools require confirmation") if the loop ever
  tries to run one. The confirm-first flow (`POST /v1/chat-assistant/actions/:key/confirm`)
  is not built yet — this repo has the contract, not the implementation.
- **Agent failure never means a dead chat.** Handoff, a thrown error, an empty final reply,
  or the same tool failing twice in one turn all make `runAgent` return `null`; the caller
  always falls back to the legacy pipeline.
- **The agent never runs while a person/job/title pick is pending.** `chatAssistant.service.js`
  checks for an open disambiguation (person, job, or title) before it ever reaches
  `isAgentTurn`/`tryAgentRoute`; pick handlers keep precedence so a bare "1" or "the first
  one" always resolves the pending pick instead of being handed to the loop as a fresh
  question.

## Context & memory

Per-step model input is `[stable prefix] + [turn context] + [history] + [this turn's tool items]`:

- **Stable prefix** — `runAgent.BASE_INSTRUCTIONS` + the permitted domains' `instructions`
  + sorted tool schemas — passed as `instructions` to `llm.step`. It must stay identical
  across users and turns so OpenAI's prompt cache hits; **never put per-user or time-varying
  data here** (that's what turn context is for).
- **Turn context** — one `developer`-role message built by `context.js`'s
  `buildAgentInput`: today's date/timezone, the user's name and resolved role names, and
  (if any) a "Previous tool calls" section rendered from the ledger.
- **History** — the last 6 turns of user/assistant text from the request's `messages`
  (`context.js`'s `trimToLastTurns`).
- **Tool ledger** — every agent turn's successful tool calls are summarized
  (`summarizeCalls`) and appended to `ConversationMemory.agentLedger`, capped to the last 6
  turns (`appendAgentLedger`). This is how a bare follow-up ("what about ai?") gets
  resolved: the model sees `count_jobs({search:'ml'}) → total 12` in turn context and
  re-calls with changed args — it never reuses a stale number from the ledger itself
  (`BASE_INSTRUCTIONS` says so explicitly).
- **This turn's tool items** grow within the loop (function calls + outputs). If the
  running input passes `CHATBOT_AGENT_INPUT_BUDGET` characters, `compactTurnItems` replaces
  the **oldest** `function_call_output`s with a short `{tool} → total {N}` summary first,
  never dropping or reordering items.

## Config

All read from `src/config/config.js` (`config.chatbot` / `config.chatbot.agent`):

| Env var | Config path | Default | Meaning |
|---|---|---|---|
| `CHATBOT_MODEL` | `chatbot.model` | *(required, no default)* | OpenAI model for Sage — router, replies, memory, role classifier, and the agent loop. Every environment must set it. |
| `CHATBOT_REASONING_EFFORT` | `chatbot.reasoningEffort` | `none` | Reasoning effort for Sage's reply-writing calls (reasoning models only). |
| `CHATBOT_AGENT` | `chatbot.agent.enabled` | `false` | Enables the tool-calling agent loop. Off by default — each host opts in explicitly. Unset/`false` runs the legacy deterministic pipeline entirely; `gate.js` is never consulted. |
| `CHATBOT_AGENT_MAX_STEPS` | `chatbot.agent.maxSteps` | `5` | Max tool-call steps per agent turn before it's forced to answer with `tool_choice: 'none'`. |
| `CHATBOT_AGENT_TOOL_TIMEOUT_MS` | `chatbot.agent.toolTimeoutMs` | `8000` | Per-tool-call timeout in the registry; `0` disables the timeout. |
| `CHATBOT_AGENT_INPUT_BUDGET` | `chatbot.agent.inputBudget` | `60000` | Max characters of this-turn tool items before `compactTurnItems` starts summarizing the oldest ones; `0` disables the budget. |

## Deploy notes

- These vars must be set in **each EC2 host's own `.env`** — staging (`dharwin/dev`) and
  production (`dharwin/main`) are separate hosts reading their own gitignored `.env`, and a
  branch merge runs nothing on either. `CHATBOT_MODEL` is required. `CHATBOT_AGENT` defaults
  to `false`, so a host stays on the legacy pipeline until someone sets `CHATBOT_AGENT=true`
  on it — enabling the loop on one host (e.g. staging) does not enable it anywhere else. The
  remaining agent vars have defaults and only need setting to change behavior.
- `ConversationMemory.agentLedger` is a new, optional Mongoose field (array, default empty).
  No migration is needed — existing documents simply have no `agentLedger` until their next
  agent turn, and `readAgentLedger` returns `[]` for a document that doesn't have one yet.

## Known limits / upgrade paths

- **~40-tool ceiling.** All permitted tools currently go into the prompt on every step.
  Every tool already carries `domain`, so the upgrade is a `find_tools(domain|query)`
  meta-tool that loads a domain's schemas into the next step, or — since our model
  (checked 2026-09-28) supports the Responses API's `tool_choice: { type: 'allowed_tools' }`
  — narrowing the *active* tool set per step while keeping the full list in the (cached)
  prefix, which avoids invalidating the prompt cache the way changing the tool list would.
  Neither is built yet; revisit when eval pick-accuracy drops or tool count crosses ~40.
- **No token streaming of the agent's final answer** — `llm.step` returns the complete
  `output_text` once the Responses API call resolves. The legacy pipeline's streaming path
  is untouched.
- **Legacy domains still route through the old pipeline** until migrated one at a time.
  Order: employees → candidates/offers → attendance/leave → interviews/tasks/projects →
  analytics → knowledge base. `jobs` (this repo) is the only migrated domain so far;
  `gate.js` only recognizes job nouns accordingly.
