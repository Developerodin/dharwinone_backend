// Sage agent tool registry (architecture.md §2). Boots by importing every domain
// module once (explicit, greppable — no fs globbing), then per request:
//   - filters tools to what `user` is permitted to call (model never sees the rest);
//   - `execute` re-checks access (defence in depth), refuses `write`-kind tools,
//     validates args with the tool's own Joi schema, runs with a timeout, applies
//     the same row-scope/redaction guard as the legacy pipeline, and caps result size.
// Chat-agnostic: nothing here imports ConversationMemory or chat renderers.

import Joi from 'joi';
import config from '../../../config/config.js';
import logger from '../../../config/logger.js';
import { defineTool, assertUniqueToolNames } from './defineTool.js';
import { checkAccessRule, guardResultForRule } from '../toolAccess.js';
import toolDomains from './tools/index.js';

const MAX_RESULT_CHARS = 20000;

export const HANDOFF_TOOL_NAME = 'handoff';

// Built-in tool, always present and never access-filtered (its `note`-only access
// has no `anyOf`, so `checkAccessRule` passes it for every user — same shape as
// TOOL_ACCESS's self-scoped entries like `fetch_my_shift`).
const handoffTool = defineTool({
  name: HANDOFF_TOOL_NAME,
  domain: 'core',
  kind: 'read',
  description: 'Hand off this conversation to the legacy Sage pipeline when no available tool can answer the question.',
  input: Joi.object({ reason: Joi.string().max(300) }),
  access: { note: 'built-in, always available' },
  execute: async () => ({ handoff: true }),
});

const defaultDomains = toolDomains;

// Fail at boot, not mid-chat, if two domains ever define the same tool name.
assertUniqueToolNames([...defaultDomains.flatMap((d) => d.tools), handoffTool]);

/**
 * Domain names whose registered index exports a `matchesTurn(text)` that returns
 * true for this turn — e.g. jobs' `matchesTurn` is the noun/ranking-query test
 * agent/gate.js used to hard-code. A domain with no `matchesTurn` never matches
 * here (see agent/README.md's "widen the gate" section for wiring one up).
 * @param {string} text
 * @param {object} [options]
 * @param {Array<{domain:string, matchesTurn?:Function}>} [options.domains] defaults to every registered domain module
 * @returns {string[]}
 */
export function matchedDomains(text, { domains = defaultDomains } = {}) {
  return domains.filter((d) => typeof d.matchesTurn === 'function' && d.matchesTurn(text)).map((d) => d.domain);
}

/**
 * True when `user` is permitted to call at least one tool belonging to
 * `domainNames` — or, when `domainNames` is `null`, at least one tool in ANY
 * registered domain (agent/gate.js's "recent agent turn, no domain named this
 * turn" case).
 * @param {object} user
 * @param {string[]|null} domainNames
 * @param {object} [options]
 * @param {Array<{domain:string, tools:Array}>} [options.domains] defaults to every registered domain module
 * @param {object} [options.deps] forwarded to checkAccessRule (toolAccess.js)
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function hasAgentToolAccess(user, domainNames, { domains = defaultDomains, deps } = {}) {
  const tools = domains
    .filter((d) => domainNames === null || domainNames.includes(d.domain))
    .flatMap((d) => d.tools);
  for (const tool of tools) {
    // eslint-disable-next-line no-await-in-loop
    const access = await checkAccessRule(tool.access, user, deps);
    if (access.ok) return { ok: true };
  }
  return { ok: false, reason: 'No permitted tool in the matched domain(s).' };
}

/** The model-facing description: the tool's own text plus its measure, when it declares one. */
function modelDescription(tool) {
  return tool.measure ? `${tool.description} Measure: ${tool.measure}` : tool.description;
}

function toResponsesSchema(tool) {
  return { type: 'function', name: tool.name, description: modelDescription(tool), parameters: tool.jsonSchema, strict: false };
}

function sizeOf(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** The array property contributing the most JSON bytes, or null if there isn't one. */
function largestArrayKey(obj) {
  let bestKey = null;
  let bestSize = -1;
  for (const [key, value] of Object.entries(obj)) {
    if (!Array.isArray(value)) continue;
    const size = sizeOf(value);
    if (size > bestSize) {
      bestKey = key;
      bestSize = size;
    }
  }
  return bestKey;
}

/** Halve the largest array property until the result fits `maxChars`, tagging `truncated: true`. */
function shrinkToFit(result, maxChars) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (sizeOf(result) <= maxChars) return result;

  let current = result;
  let truncated = false;
  for (let i = 0; i < 50; i += 1) {
    const key = largestArrayKey(current);
    const arr = key && current[key];
    if (!arr || arr.length === 0) break;
    current = { ...current, [key]: arr.slice(0, Math.floor(arr.length / 2)) };
    truncated = true;
    if (sizeOf(current) <= maxChars) break;
  }
  return truncated ? { ...current, truncated: true } : current;
}

function parseRawArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    return trimmed === '' ? {} : JSON.parse(trimmed);
  }
  if (typeof rawArgs === 'object') return rawArgs;
  throw new Error(`arguments must be an object or a JSON string (got ${typeof rawArgs})`);
}

async function runWithTimeout(fn, timeoutMs) {
  if (!(timeoutMs > 0)) return fn();
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} user
 * @param {object} [options]
 * @param {Array<{domain:string, instructions:string, tools:Array}>} [options.domains] defaults to every registered domain module
 * @param {object} [options.deps] injected for tests (see toolAccess.js checkAccessRule/guardResultForRule)
 * @returns {Promise<{schemas:Array, instructions:string, execute:Function, render:Function, isHandoff:Function}>}
 */
export async function getAgentTools(user, { domains = defaultDomains, deps } = {}) {
  const allTools = [...domains.flatMap((d) => d.tools), handoffTool];
  assertUniqueToolNames(allTools);

  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));

  const permittedNames = new Set();
  for (const tool of allTools) {
    // eslint-disable-next-line no-await-in-loop
    const access = await checkAccessRule(tool.access, user, deps);
    if (access.ok) permittedNames.add(tool.name);
  }

  const permittedTools = allTools
    .filter((tool) => permittedNames.has(tool.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const schemas = permittedTools.map(toResponsesSchema);

  const instructions = domains
    .filter((domain) => domain.tools.some((tool) => permittedNames.has(tool.name)))
    .slice()
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((domain) => domain.instructions)
    .join('\n\n');

  async function execute(name, rawArgs, { requestId } = {}) {
    const startedAt = Date.now();
    let ok = false;
    try {
      const tool = toolsByName.get(name);
      if (!tool) return { ok: false, error: `Unknown tool '${name}'.` };

      // Re-check access here even though schemas already hid unpermitted tools —
      // defence in depth (architecture.md §2): the model could still name a tool
      // it was never shown.
      const access = await checkAccessRule(tool.access, user, deps);
      if (!access.ok) return { ok: false, error: access.reason || 'Not permitted.' };

      if (tool.kind === 'write') return { ok: false, error: 'write tools require confirmation' };

      let args;
      try {
        args = parseRawArgs(rawArgs);
      } catch (err) {
        return { ok: false, error: `Invalid arguments: ${err.message}` };
      }

      const { value, error: joiError } = tool.input.validate(args, { abortEarly: false });
      if (joiError) {
        return { ok: false, error: joiError.details.map((d) => d.message).join('; ') };
      }

      const timeoutMs = config.chatbot.agent.toolTimeoutMs;
      let result;
      try {
        result = await runWithTimeout(() => tool.execute(value, { user, requestId, deps }), timeoutMs);
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }

      const guarded = await guardResultForRule(tool.access, result, user, deps);
      const capped = shrinkToFit(guarded, MAX_RESULT_CHARS);
      // The result is what reaches the model (runAgent serialises it as the
      // function_call_output), so the measure rides on it for the reply to quote.
      const withMeasure = tool.measure && capped && typeof capped === 'object' && !Array.isArray(capped)
        ? { ...capped, measure: tool.measure }
        : capped;

      ok = true;
      return { ok: true, result: withMeasure };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    } finally {
      const ms = Date.now() - startedAt;
      logger.info(`[toolRegistry] ${JSON.stringify({ tool: name, ms, ok, requestId })}`);
    }
  }

  function render(name, result) {
    const tool = toolsByName.get(name);
    return (tool && tool.render && tool.render(result)) ?? null;
  }

  function isHandoff(name) {
    return name === HANDOFF_TOOL_NAME;
  }

  return { schemas, instructions, execute, render, isHandoff };
}
