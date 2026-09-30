// Sage agent tool registry (architecture.md §2). Boots by importing every domain
// module once (explicit, greppable — no fs globbing), then per request:
//   - filters tools to what `user` is permitted to call (model never sees the rest);
//   - above EAGER_TOOL_LIMIT permitted tools, offers only handoff + find_tools and lets
//     the loop load domains on demand (`loadDomains`);
//   - `execute` re-checks access (defence in depth), refuses `write`-kind tools,
//     validates args with the tool's own Joi schema, runs with a timeout, applies
//     the same row-scope/redaction guard as the legacy pipeline, and caps result size.
// Chat-agnostic: nothing here imports ConversationMemory or chat renderers.

import Joi from 'joi';
import config from '../../../config/config.js';
import logger from '../../../config/logger.js';
import { defineTool, assertUniqueToolNames } from './defineTool.js';
import { runWithTimeout } from './runWithTimeout.js';
import { checkAccessRule, guardResultForRule } from '../toolAccess.js';
import toolDomains from './tools/index.js';
import { assertRelatedToolsExist } from '../personProfile/providers/index.js';

const MAX_RESULT_CHARS = 20000;

// ponytail: above this many permitted tools the prompt carries only handoff + find_tools and
// the model loads domains on demand. Ceiling: the find_tools catalog (one line per domain)
// itself grows with every domain; upgrade = nested domains or embedding-based tool search.
export const EAGER_TOOL_LIMIT = 30;

export const HANDOFF_TOOL_NAME = 'handoff';
export const FIND_TOOLS_NAME = 'find_tools';
const MAX_DOMAINS_PER_FIND = 5;
const MAX_SUMMARY_CHARS = 120;

export const LAZY_INSTRUCTIONS = [
  'Tools are grouped by domain and most are not loaded yet.',
  'Before answering any question about company data, call `find_tools` with every domain the question touches ' +
    '(several at once when it spans modules). You may call it again later in the turn.',
  "Only call `handoff` if no domain in find_tools' list can answer.",
].join('\n');

// Built-in tool, always present and never access-filtered (its `note`-only access
// has no `anyOf`, so `checkAccessRule` passes it for every user — same shape as
// self-scoped agent tools like `get_my_profile`).
const handoffTool = defineTool({
  name: HANDOFF_TOOL_NAME,
  domain: 'core',
  kind: 'read',
  description: 'Call when no available tool can answer the question; Sage then tells the user it cannot answer that yet.',
  input: Joi.object({ reason: Joi.string().max(300) }),
  access: { note: 'built-in, always available' },
  execute: async () => ({ handoff: true }),
});

const defaultDomains = toolDomains;

/**
 * Throws unless every domain module carries a one-line `summary` (≤ 120 chars) —
 * it is that domain's line in the find_tools catalog, all the model sees of an
 * unloaded domain.
 */
export function assertDomainSummaries(domains) {
  for (const d of domains) {
    const { summary } = d;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error(`Domain '${d.domain}' is missing a summary`);
    }
    if (summary.length > MAX_SUMMARY_CHARS || /[\r\n]/.test(summary)) {
      throw new Error(`Domain '${d.domain}' summary must be one line of at most ${MAX_SUMMARY_CHARS} characters`);
    }
  }
}

// Fail at boot, not mid-chat, if two domains ever define the same tool name (or shadow find_tools).
assertUniqueToolNames([...defaultDomains.flatMap((d) => d.tools), handoffTool, { name: FIND_TOOLS_NAME }]);
assertDomainSummaries(defaultDomains);
// get_user's profile sections name follow-up tools (personProfile providers' relatedTools);
// fail at boot if one names a tool the agent does not have.
assertRelatedToolsExist(defaultDomains.flatMap((d) => d.tools.map((t) => t.name)));

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

/**
 * find_tools for one user: its description is the catalog of the domains this user
 * has at least one tool in, and its input only accepts those domain names (1–5, no
 * repeats). The model-facing schema and the loop's validation are the same Joi schema.
 */
function buildFindTools(permittedDomains) {
  const names = permittedDomains.map((d) => d.domain);
  const catalog = permittedDomains.map((d) => `- ${d.domain} — ${d.summary}`).join('\n');
  return defineTool({
    name: FIND_TOOLS_NAME,
    domain: 'core',
    kind: 'read',
    description:
      'Loads the tools for one or more domains so you can call them in your next step. Call it before answering ' +
      'any question about company data, with every domain the question touches. Not needed for greetings or ' +
      `general-knowledge definitions.\nDomains:\n${catalog}`,
    input: Joi.object({
      domains: Joi.array()
        .items(Joi.string().valid(...names))
        .min(1)
        .max(MAX_DOMAINS_PER_FIND)
        .unique()
        .required()
        .description('1 to 5 domain names, no repeats.'),
    }),
    access: { note: 'built-in, loads permitted tools only' },
    execute: async () => {
      throw new Error(`${FIND_TOOLS_NAME} is handled by the loop`);
    },
  });
}

/**
 * @param {object} user
 * @param {object} [options]
 * @param {Array<{domain:string, summary:string, instructions:string, tools:Array}>} [options.domains] defaults to every registered domain module
 * @param {object} [options.deps] injected for tests (see toolAccess.js checkAccessRule/guardResultForRule)
 * @param {number} [options.eagerLimit] permitted tools (handoff excluded) above which the registry goes lazy
 * @returns {Promise<{schemas:Array, instructions:string, lazy:boolean, execute:Function, render:Function,
 *   isHandoff:Function, isFindTools:Function, domainOfTool:Function, loadDomains:Function, parseFindToolsArgs:Function}>}
 */
export async function getAgentTools(user, { domains = defaultDomains, deps, eagerLimit = EAGER_TOOL_LIMIT } = {}) {
  assertDomainSummaries(domains);
  const allTools = [...domains.flatMap((d) => d.tools), handoffTool];
  assertUniqueToolNames([...allTools, { name: FIND_TOOLS_NAME }]);

  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));

  const permittedNames = new Set();
  for (const tool of allTools) {
    // eslint-disable-next-line no-await-in-loop
    const access = await checkAccessRule(tool.access, user, deps);
    if (access.ok) permittedNames.add(tool.name);
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const permittedDomains = domains
    .filter((domain) => domain.tools.some((tool) => permittedNames.has(tool.name)))
    .slice()
    .sort((a, b) => a.domain.localeCompare(b.domain));

  function domainBundle(domainList) {
    const tools = domainList.flatMap((d) => d.tools.filter((t) => permittedNames.has(t.name))).sort(byName);
    return {
      schemas: tools.map(toResponsesSchema),
      instructions: domainList.map((domain) => domain.instructions).join('\n\n'),
    };
  }

  const permittedDomainToolCount = permittedDomains.reduce(
    (n, d) => n + d.tools.filter((t) => permittedNames.has(t.name)).length,
    0
  );
  const findTools = permittedDomains.length ? buildFindTools(permittedDomains) : null;
  const lazy = !!findTools && permittedDomainToolCount > eagerLimit;

  let schemas;
  let instructions;
  if (lazy) {
    schemas = [findTools, handoffTool].sort(byName).map(toResponsesSchema);
    instructions = LAZY_INSTRUCTIONS;
  } else {
    const permittedTools = allTools.filter((tool) => permittedNames.has(tool.name)).sort(byName);
    schemas = permittedTools.map(toResponsesSchema);
    instructions = domainBundle(permittedDomains).instructions;
  }

  /** Permitted tools of the named domains; unknown or unpermitted names load nothing. */
  function loadDomains(names) {
    const wanted = new Set(Array.isArray(names) ? names : []);
    const picked = permittedDomains.filter((d) => wanted.has(d.domain));
    return { ...domainBundle(picked), loaded: picked.map((d) => d.domain) };
  }

  /** find_tools args (JSON string or object) → `{ domains }` or `{ error }`. */
  function parseFindToolsArgs(rawArgs) {
    if (!findTools) return { error: 'No domains are available to load.' };
    let args;
    try {
      args = parseRawArgs(rawArgs);
    } catch (err) {
      return { error: `Invalid arguments: ${err.message}` };
    }
    const { value, error } = findTools.input.validate(args, { abortEarly: false });
    if (error) return { error: error.details.map((d) => d.message).join('; ') };
    return { domains: value.domains };
  }

  // The module's domain (what loadDomains keys on), not the tool's own `domain` field.
  const domainByToolName = new Map(domains.flatMap((d) => d.tools.map((t) => [t.name, d.domain])));
  function domainOfTool(name) {
    return domainByToolName.get(name) ?? null;
  }

  // Eager registries never offer find_tools, so a hallucinated call to it stays an unknown tool
  // (same as before lazy loading existed) instead of silently "loading" what is already there.
  function isFindTools(name) {
    return lazy && name === FIND_TOOLS_NAME;
  }

  async function execute(name, rawArgs, { requestId } = {}) {
    const startedAt = Date.now();
    let ok = false;
    try {
      if (isFindTools(name)) return { ok: false, error: `${FIND_TOOLS_NAME} is handled by the loop` };
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

      const timeoutMs = tool.timeoutMs ?? config.chatbot.agent.toolTimeoutMs;
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

  return {
    schemas,
    instructions,
    lazy,
    execute,
    render,
    isHandoff,
    isFindTools,
    domainOfTool,
    loadDomains,
    parseFindToolsArgs,
  };
}
