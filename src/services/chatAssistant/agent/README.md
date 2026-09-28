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

1. `chatAssistant.service.js` checks for an open **person** disambiguation pick
   (`readPending`, from `personProfile/pendingPerson.js`) before `tryAgentRoute` is even
   called (`chatAssistant.service.js:8264` and the streaming path's `:8585`) — a bare "1" or
   "the first one" in reply to a person pick always resolves that pick, never reaches the
   agent.
2. `tryAgentRoute` (`chatAssistant.service.js`) calls `tryAgentTurn` (`agent/gate.js`) — the
   real gate. In order: the `CHATBOT_AGENT` flag, then a domain-generic turn test (skipped
   when the caller already routed here via `routerPicked`) — the turn matches when
   `agent/toolRegistry.js`'s `matchedDomains(lastUserMsg)` names at least one registered
   domain (each domain's own `matchesTurn(text)`, e.g. `jobs`') or the agent answered
   the last tool-backed turn recently (`hasRecentAgentTurn`) — then `checkAccess`, which is
   `hasAgentToolAccess(user, matchedDomains)`: the user must be able to call at least one tool
   in a matched domain, or — when no domain was named this turn (a noun-less recency-window
   follow-up) — at least one agent tool at all. Then `hasPendingPick(lastUserMsg, memDoc)` —
   which checks the **job**, **title**, **entity** (user-vs-role), and **person** disambiguation
   readers (`readPendingJob`, `readPendingTitle`, `readPendingEntity`, `personProfile/pendingPerson.js`'s
   `readPending`) plus a "what about jobs" switch-back regex (`JOB_ENTITY_SWITCH_RE`). Any of
   these being open skips the agent for this turn. The whole gate runs in one `try/catch`; a
   thrown error also skips the agent.
3. Only past all of that does `tryAgentTurn` call `runAgent(...)` (`agent/runAgent.js`).
4. `runAgent` builds the tool list with `getAgentTools(user)` (`agent/toolRegistry.js`),
   permission-filtered so the model never sees a tool the user can't call.
5. `runAgent` loops `llm.step(...)` (`agent/llm.js`, the OpenAI Responses API) up to
   `CHATBOT_AGENT_MAX_STEPS` times: each step may return tool calls, which the registry's
   `execute(name, args)` runs — capped at `MAX_CALLS_PER_STEP = 8` per step; any call beyond
   the first 8 gets a canned `{"error":"too many calls in one step"}` output instead of
   actually running — or a final text answer.
6. Successful tool results are rendered (`tool.render(result)` → `{ blocks, facts }`),
   the facts are merged and passed to `enforceCounts`, which corrects counts against this
   turn's tool totals. A reply with a digit but no successful tool call is rejected (step 8).
7. `runAgent` returns `{ reply, blocks, meta, ledgerEntry }`; `tryAgentTurn` persists
   `ledgerEntry` onto `ConversationMemory.agentLedger` via `appendAgentLedger` when it holds
   at least one tool call (a no-tool answer writes nothing) — `runAgent` itself never writes
   to the DB.
8. Anything that isn't a clean answer — the model calling `handoff`, a thrown error, the
   same tool failing twice, an empty final reply that's still empty after one
   `tool_choice:'none'` retry, a digit in a reply with no successful tool call, or the turn
   deadline — makes `runAgent` return `null`, and the caller falls through to the legacy
   pipeline, which then runs exactly as with the flag off. If the recency window was open,
   `tryAgentTurn` appends a `{ at, handoff: true }` marker that closes it, so the next
   noun-less turn goes straight to legacy. Sage never goes dark because of the agent.

```
service.js --readPending(person)--> tryAgentRoute --> tryAgentTurn (gate.js)
                                       flag -> matchedDomains/isAgentTurn -> checkAccess -> hasPendingPick(job/title/entity/person)
                                                                                  |
                                                                                  v
                                                        runAgent --getAgentTools--> llm.step (loop, <=8 calls/step) --> registry.execute
    ^                                                                                                                          |
    |<----------------------------------- null (gate skip / handoff / error / empty) ----------------------------------------|
    |
    +--> legacy pipeline (fallback)
```

## Registered domains

### jobs

The reference domain (`agent/tools/jobs/`): `count_jobs`, `list_jobs`, `get_job`,
`rank_jobs_by_salary`. Access is `jobs.read`.

### people

`agent/tools/people/` (`CONTRACT.md` in that directory is the binding spec). Covers user
accounts (logins) in the Users directory and the roles those accounts hold — **not**
Employee/Candidate/Student/etc. profile data beyond what `get_user` surfaces. Status
defaults to `active` for user counts/lists unless the caller asks for another status or
"all".

| Tool | Purpose | Key args | Access |
|---|---|---|---|
| `count_users` | Count user accounts, optionally grouped by `role` or `status`. With `groupBy:'role'`, `total` is a distinct-user count (never the sum of the groups — a user with 2 roles counts in both groups, so the raw sum is kept separately as `assignmentCount`); with `groupBy:'status'` the sum is the correct total, since status is exclusive. | `filters` (search/status/role/location/domain/education), `groupBy` (`role`\|`status`) | `users.read` |
| `list_users` | List user accounts (`id`, `name`, `email`, `roles`, `status`, `lastLoginAt`), newest first; `total` is always the full filtered count. | `filters`, `limit` (default 10, max 25) | `users.read` |
| `get_user` | One person's full profile (user account + every role-specific profile they hold), by id or name. Name resolution excludes the platform-super account (unless the viewer is one) and deleted accounts, and prefers a single exact name/email match over asking to disambiguate. Ambiguous name → `{ matches }`; no match → `{ matches: [] }`. | `id` or `name` (one required) | `users.read`, `rowScope: 'person'` |
| `list_roles` | List the roles defined in the system, with how many active users hold each. | `status` (`active`\|`inactive`) | `roles.read` |
| `get_role` | One role's definition: name, aliases, status, full permission list. Exact match only (name, alias, or a former name) — no partial match. | `name` (required) | `roles.read` |

Routing notes (see `agent/tools/people/index.js`'s `instructions` for the full text the
model reads): "how many admins/recruiters/sales agents" and "who has role X" are
`count_users`/`list_users` with a `role` filter, **not** `list_roles`; "what can a Sales
Agent do" / "what permissions does X role have" is `get_role`; a short follow-up that's
just a person's name is a `get_user` call, not a filter on the previous `count_users`/
`list_users` call. Full rulings and rationale: `agent/tools/people/CONTRACT.md`.

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
  domain: 'widgets',               // groups instructions + schemas; drives the find_tools/allowed_tools upgrade path (see Known limits below)
  kind: 'read',                    // 'read' runs in the loop; 'write' is refused by the loop (see below)
  description: 'Count widgets the user can see. Use for "how many widgets…".', // the MODEL reads this — be specific about when to call it
  input: Joi.object({
    filters: Joi.object({ search: Joi.string().min(1) }),
  }),
  // { anyOf: [...] } (>=1 permission string) or { note: '...' } when a handler
  // already enforces its own check — same shape as toolAccess.js TOOL_ACCESS entries.
  // Co-locate it as a constant in common.js (like jobs' JOBS_ACCESS) so every tool in
  // the domain shares one definition.
  access: MY_DOMAIN_ACCESS,
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

`expect.tools` is the exact set of tool names expected (order-independent, one call per
tool). By default a case fails if the actual call count exceeds `expect.tools.length` —
add an optional `expect.maxCalls` to raise that ceiling for a case that legitimately needs
more calls than distinct tools (e.g. two calls to `count_jobs` to compare two filters):

```json
{ "id": "compare-two-searches", "question": "how many react jobs vs how many vue jobs?",
  "expect": { "tools": ["count_jobs"], "maxCalls": 2 } }
```

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

`agent/gate.js` is domain-generic: it doesn't hard-code any domain's nouns. A domain index
(`agent/tools/<domain>/index.js`) may export an optional `matchesTurn(text) => boolean` —
jobs' is the noun/ranking-query test (`hasJobSubjectNoun(text) || looksLikeJobRankingQuery(text)`),
moved out of `gate.js` and into `agent/tools/jobs/index.js`. `agent/toolRegistry.js`'s
`matchedDomains(text)` runs every registered domain's `matchesTurn` and returns the names of
the ones that matched; a domain with no `matchesTurn` export never matches this way. So:
adding `matchesTurn` to a new domain's `index.js` is enough to widen `gate.js`'s
`isAgentTurn` (any domain matches, or the user's last turn was a recent agent turn — see
`hasRecentAgentTurn`) and the access check (`hasAgentToolAccess(user, matchedDomains)`:
≥1 permitted tool in a matched domain, or — with no domain named this turn — ≥1 permitted
agent tool at all) for free. No `gate.js` edit needed for either.

One place still needs a manual addition per domain:
- **`hasPendingPick`** reads a fixed list of pending-pick readers — job, title, entity, and
  now person (`personProfile/pendingPerson.js`'s `readPending`). A new domain with its own
  disambiguation flow (e.g. "which John did you mean?") needs its reader added here too, or
  the agent will take a bare "1" / "the first one" meant for that domain's disambiguation
  while the recency window is open.

## Rules that keep it safe

- **RBAC is checked twice.** `getAgentTools` hides tools the user can't call (the model
  never sees them); `registry.execute` re-checks access on every call regardless, because
  the model can still name a tool it was never shown.
- **Numbers only come from this turn's tools.** `runAgent` merges `render()`'s `facts` and
  runs `enforceCounts` on the final text, which rewrites a count that disagrees with a
  tool's total. That only covers counts a tool reported: it cannot check a number when no
  tool ran. So a reply containing any digit with **no successful tool call** this turn is
  not shipped — `runAgent` returns `null` (outcome `untooled_number`) and the legacy
  pipeline answers. Digit-free no-tool replies (e.g. defining "MERN") still ship; keeping
  those from being company facts rests on `BASE_INSTRUCTIONS` (company policies, people and
  data → tool or `handoff`).
- **Turns are time-boxed.** Each model step has a per-request timeout
  (`CHATBOT_AGENT_STEP_TIMEOUT_MS`, SDK retries off) and the turn has a deadline
  (`CHATBOT_AGENT_TURN_TIMEOUT_MS`); each step gets at most the time left. Past the deadline
  `runAgent` returns `null` (outcome `deadline`) and the legacy pipeline answers.
- **Results are size-capped, but only at the top level.** The registry's `shrinkToFit`
  (`MAX_RESULT_CHARS = 20000`) only shrinks the largest top-level **array** property,
  tagging `truncated: true`. A single large scalar field (e.g. `get_job`'s job description)
  is not touched by that cap — bound it yourself in the tool, the way `get_job.tool.js`'s
  `boundDescription` truncates at `MAX_DESCRIPTION_CHARS`.
- **Write tools are refused by the loop.** `kind: 'write'` tools are a contract for later:
  `registry.execute` returns an error ("write tools require confirmation") if the loop ever
  tries to run one. The confirm-first flow (`POST /v1/chat-assistant/actions/:key/confirm`)
  is not built yet — this repo has the contract, not the implementation.
- **Agent failure never means a dead chat.** Handoff, a thrown error, or the same tool
  failing twice in one turn all make `runAgent` return `null` immediately. An empty final
  reply gets one retry first — `runAgent.js` re-asks with `tool_choice:'none'` on the same
  input — and only returns `null` if that retry is *also* empty. Either way, the caller
  always falls back to the legacy pipeline.
- **Per-step tool-call cap.** `runAgent.js`'s `MAX_CALLS_PER_STEP = 8`: the model can emit
  dozens of parallel calls in one step when its tools don't fit the question, so only the
  first 8 actually run; the rest get a `{"error":"too many calls in one step"}` output so
  every call still has a matching result and the model sees the cap was hit.
- **The agent never runs while a pick is pending, and the person check is now doubled up
  on purpose.** `chatAssistant.service.js` resolves an open **person** disambiguation
  (`readPending`) before `tryAgentRoute` is even called. `agent/gate.js`'s `tryAgentTurn`
  separately checks `hasPendingPick` — **job**, **title**, **entity** (user-vs-role), and
  **person** (`personProfile/pendingPerson.js`'s `readPending`, off the already-loaded
  `memDoc`) picks, plus the `JOB_ENTITY_SWITCH_RE` "what about jobs" switch-back — as the
  *last* gate condition, right before calling `runAgent` (after the domain-match/recency
  test and `checkAccess`, not before). The person check exists at both layers deliberately:
  `chatAssistant.service.js`'s is the one that actually runs first in the request flow, and
  `hasPendingPick`'s is defense in depth for `tryAgentTurn` itself (and for any future caller
  that skips the service.js check). Either way, a bare "1" or "the first one" always resolves
  the open pick instead of being handed to the loop as a fresh question.

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
  entries (`appendAgentLedger`). Turns with no tool calls append nothing; a handoff inside
  the recency window appends a `{ at, handoff: true }` marker (no `calls`, skipped on replay)
  that closes the window. This is how a bare follow-up ("what about ai?") gets
  resolved: the model sees `count_jobs({"search":"ml"}) → total 12` in turn context and
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
| `CHATBOT_AGENT_STEP_TIMEOUT_MS` | `chatbot.agent.stepTimeoutMs` | `20000` | Per-request timeout for one model step (`responses.create`), with SDK retries disabled. A timeout is a thrown error → legacy fallback. |
| `CHATBOT_AGENT_TURN_TIMEOUT_MS` | `chatbot.agent.turnTimeoutMs` | `30000` | Deadline for the whole agent turn. Checked before each step, and each step's timeout is capped to the time left; past it the turn falls back to legacy. |
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
  Order: jobs → employees/people → candidates/applications/placements/offers →
  attendance/leave/holidays/shifts → interviews/meetings/tasks/projects → analytics tools →
  knowledge base/roles. `jobs` and `people` (users + roles; see "Registered domains" above)
  are migrated so far — employees/candidates are next. `gate.js` itself is domain-generic
  (§5), so a new domain reaches it by exporting `matchesTurn`, not by editing `gate.js`.
