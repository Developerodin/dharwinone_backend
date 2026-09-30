import { toJsonSchema } from './toJsonSchema.js';

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const KINDS = ['read', 'write'];
// Must stay under CHATBOT_AGENT_STEP_TIMEOUT_MS (20000) so a slow tool fails before the model step does.
const MAX_TIMEOUT_MS = 15000;
// A draft's summary lists every target, and confirm compares those ids against a fresh
// prepare. Ceiling: raising this past 50 needs a full target-id list stored apart from
// the displayed summary.targets.
export const MAX_TARGETS = 50;

function fail(name, message) {
  const label = name || '(unnamed tool)';
  throw new Error(`defineTool(${label}): ${message}`);
}

function isJoiObjectSchema(schema) {
  return !!schema && typeof schema.describe === 'function' && schema.describe().type === 'object';
}

const isPermissionList = (list) =>
  Array.isArray(list) && list.length > 0 && list.every((p) => typeof p === 'string' && p.length > 0);

// Mirrors src/services/chatAssistant/toolAccess.js checkAccessRule semantics:
// `anyOf` and/or `allOf` (non-empty permission lists) or `note` (handler already enforces access).
function isValidAccess(access) {
  if (!access || typeof access !== 'object') return false;
  if (access.anyOf !== undefined && !isPermissionList(access.anyOf)) return false;
  if (access.allOf !== undefined && !isPermissionList(access.allOf)) return false;
  const hasNote = typeof access.note === 'string' && access.note.trim().length > 0;
  return access.anyOf !== undefined || access.allOf !== undefined || hasNote;
}

function checkWriteShape(name, { execute, prepare, commit, recheck, maxTargets }) {
  if (execute !== undefined) {
    fail(name, 'write tools define prepare(value, ctx) and commit(draft, ctx), not execute');
  }
  if (typeof prepare !== 'function') fail(name, 'write tools require prepare(value, ctx)');
  if (typeof commit !== 'function') fail(name, 'write tools require commit(draft, ctx)');
  if (recheck !== undefined && typeof recheck !== 'function') {
    fail(name, 'recheck must be a function when present');
  }
  if (maxTargets !== undefined && !(Number.isInteger(maxTargets) && maxTargets > 0 && maxTargets <= MAX_TARGETS)) {
    fail(name, `maxTargets must be an integer from 1 to ${MAX_TARGETS} when present`);
  }
}

/**
 * Defines one agent tool (`agent/tools/<domain>/<name>.tool.js`). Validates the
 * definition and computes its JSON Schema up front so a bad tool throws at
 * load time, never mid-chat. See architecture.md §1.
 *
 * `measure` (optional; required by convention for count_* / list_* tools — see
 * tools/people/CONTRACT.md) is one sentence naming WHAT is counted (accounts vs
 * profiles vs records) and the default status scope. The registry appends it to
 * the description the model sees and to every result the tool returns, so a
 * reply can say which measure a number is.
 *
 * `timeoutMs` (optional) overrides config.chatbot.agent.toolTimeoutMs for this
 * tool, e.g. a composite tool that runs several others.
 *
 * `kind: 'write'` tools have no `execute`. They define `prepare(value, ctx)`
 * (read-only: resolves targets under the caller's scope and returns
 * `{ ok, summary, payload }` or `{ ok: false, error }`) and `commit(draft, ctx)`
 * (performs the write from `draft.payload`, returns `{ ok, message, details? }`),
 * plus optional `recheck(draft, ctx)` (replaces the default re-prepare on confirm)
 * and `maxTargets` (default and ceiling MAX_TARGETS). See agent/sageActions.js.
 */
export function defineTool(def) {
  const {
    name, domain, kind, description, measure, input, access, execute, prepare, commit, recheck, maxTargets, render, timeoutMs,
  } = def || {};

  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail(name, `name must match ${NAME_RE} (got ${JSON.stringify(name)})`);
  }
  if (typeof domain !== 'string' || domain.length === 0) {
    fail(name, 'domain is required (non-empty string)');
  }
  if (!KINDS.includes(kind)) {
    fail(name, `kind must be 'read' or 'write' (got ${JSON.stringify(kind)})`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    fail(name, 'description is required (non-empty string)');
  }
  if (measure !== undefined && (typeof measure !== 'string' || measure.trim().length === 0)) {
    fail(name, 'measure must be a non-empty string when present');
  }
  if (!isJoiObjectSchema(input)) {
    fail(name, 'input must be a Joi object schema');
  }
  if (!isValidAccess(access)) {
    fail(name, "access must be { anyOf: [...] } and/or { allOf: [...] } (non-empty) or { note: '...' } (see toolAccess.js)");
  }
  if (kind === 'write') {
    checkWriteShape(name, { execute, prepare, commit, recheck, maxTargets });
  } else if (typeof execute !== 'function') {
    fail(name, 'execute must be a function');
  }
  if (render !== undefined && typeof render !== 'function') {
    fail(name, 'render must be a function when present');
  }
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    fail(name, `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} when present`);
  }

  let jsonSchema;
  try {
    jsonSchema = toJsonSchema(input);
  } catch (err) {
    fail(name, `input schema conversion failed: ${err.message}`);
  }

  if (kind === 'write') {
    return Object.freeze({
      name, domain, kind, description, measure, input, access, prepare, commit, recheck,
      maxTargets: maxTargets ?? MAX_TARGETS, render, timeoutMs, jsonSchema,
    });
  }
  return Object.freeze({ name, domain, kind, description, measure, input, access, execute, render, timeoutMs, jsonSchema });
}

/**
 * Throws on a duplicate tool name. `defineTool` only sees one definition at a
 * time, so the registry (Task 4) calls this once over the full tool list.
 */
export function assertUniqueToolNames(tools) {
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name: '${tool.name}'`);
    }
    seen.add(tool.name);
  }
}
