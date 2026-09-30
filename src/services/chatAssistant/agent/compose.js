// Composition: a tool calls another registered tool under the caller's access, with the
// same access check, write refusal, Joi validation, timeout and row-scope guard as
// toolRegistry.execute. Never throws; returns a status the composite reports per section.
// The model-facing extras (size cap, measure) stay in the registry, applied once to the
// composite's own result.

import { checkAccessRule, guardResultForRule } from '../toolAccess.js';
import { runWithTimeout, TOOL_TIMEOUT } from './runWithTimeout.js';

// A composite may call another composite once; a third level is refused so tools never loop.
export const MAX_COMPOSE_DEPTH = 2;

async function findTool(name) {
  // Dynamic: tools/index.js imports every domain, and composite tools import this file.
  const { default: domains } = await import('./tools/index.js');
  for (const domain of domains) {
    const tool = domain.tools.find((t) => t.name === name);
    if (tool) return tool;
  }
  return null;
}

/**
 * @param {string} name registered tool name
 * @param {object} args tool input, validated with the tool's Joi schema
 * @param {{ user: object, deps?: object, requestId?: string, composeDepth?: number }} ctx the caller's ctx
 * @returns {Promise<{ status: 'ok', result: any } | { status: 'restricted' } | { status: 'invalid', error: string }
 *   | { status: 'timeout' } | { status: 'error', error: string } | { status: 'unknown' }>}
 */
export async function runTool(name, args, ctx = {}, { timeoutMs = 6000 } = {}) {
  try {
    const depth = (ctx.composeDepth ?? 0) + 1;
    if (depth > MAX_COMPOSE_DEPTH) {
      return { status: 'error', error: `compose depth limit (${MAX_COMPOSE_DEPTH}) reached calling '${name}'` };
    }

    const tool = await findTool(name);
    if (!tool) return { status: 'unknown' };

    const access = await checkAccessRule(tool.access, ctx.user, ctx.deps);
    if (!access.ok) return { status: 'restricted' };

    if (tool.kind === 'write') return { status: 'error', error: 'write tools require confirmation' };

    const { value, error } = tool.input.validate(args ?? {}, { abortEarly: false });
    if (error) return { status: 'invalid', error: error.details.map((d) => d.message).join('; ') };

    let result;
    try {
      result = await runWithTimeout(() => tool.execute(value, { ...ctx, composeDepth: depth }), timeoutMs);
    } catch (err) {
      if (err?.code === TOOL_TIMEOUT) return { status: 'timeout' };
      return { status: 'error', error: err?.message || String(err) };
    }

    return { status: 'ok', result: await guardResultForRule(tool.access, result, ctx.user, ctx.deps) };
  } catch (err) {
    return { status: 'error', error: err?.message || String(err) };
  }
}

/** Runs independent sections in parallel: `calls` is `[{ name, args, timeoutMs? }]`, results in the same order. */
export function runTools(calls, ctx) {
  return Promise.all(calls.map(({ name, args, timeoutMs }) => runTool(name, args, ctx, { timeoutMs })));
}
