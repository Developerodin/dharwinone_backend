import crypto from 'node:crypto';
import logger from '../config/logger.js';

/**
 * Push a STATIC prompt template onto a Bolna agent, once, and prove it landed.
 *
 * The template is byte-identical on every call, so this is not per-call state: the first
 * call in a process pays for one PATCH plus one read-back, and every later call is free.
 * That is the whole point — the old path PATCHed a freshly-rendered prompt before each
 * dial, which made the agent's prompt a shared mutable race between every process using
 * that agent (production and staging share one Bolna account).
 *
 * Two rules from the Bolna API, both learned the hard way:
 *   - A `200 {"state":"updated"}` proves nothing. Always read the agent back.
 *   - `agent_config` maps only to TOP-LEVEL agent fields, which is why the welcome message
 *     can ride along here but `task_config` cannot be set this way at all.
 *
 * Returns `{ ok: false }` when the template could not be confirmed live. Callers MUST NOT
 * dial in that case: before a first confirmed sync the agent may still be holding an older
 * fully-resolved prompt carrying somebody else's job or candidate.
 */

/** agentId -> fingerprint of the template last CONFIRMED live on that agent. */
const confirmed = new Map();

const fingerprint = (text) =>
  crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);

/** Pull every `system_prompt` string out of a Bolna agent GET response (it is nested). */
function extractSystemPrompts(agent) {
  const out = [];
  try {
    JSON.stringify(agent, (key, value) => {
      if (key === 'system_prompt' && typeof value === 'string') out.push(value);
      return value;
    });
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * @param {Object} deps
 * @param {(id: string, prompt: string, opts?: Object) => Promise<{success: boolean, error?: string}>} deps.updateAgentPrompt
 * @param {(id: string) => Promise<{success: boolean, agent?: Object, error?: string}>} deps.getAgent
 * @param {string} agentId
 * @param {string} template - the static prompt template ({placeholders} only, no per-call data)
 * @param {string} [welcomeTemplate] - static welcome message, also with {placeholders}
 * @returns {Promise<{ ok: boolean, cached?: boolean, error?: string }>}
 */
export async function ensureAgentPrompt(deps, agentId, template, welcomeTemplate) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: 'agentId is required.' };
  if (!template) return { ok: false, error: 'template is required.' };

  const fp = fingerprint(`${template} ${welcomeTemplate || ''}`);
  if (confirmed.get(id) === fp) return { ok: true, cached: true };

  const patch = await deps.updateAgentPrompt(id, template, {
    agentWelcomeMessage: welcomeTemplate,
  });
  if (!patch.success) {
    logger.error(`[Bolna] template PATCH failed for agent ${id} (fp=${fp}): ${patch.error}`);
    return { ok: false, error: patch.error };
  }

  // Read back. A concurrent writer can still land between this check and the dial, but the
  // template is a constant — if someone else wrote the SAME template, the call is unaffected.
  // The only losing case is another process still running the old per-call-prompt code.
  const got = await deps.getAgent(id);
  if (!got.success) {
    logger.error(`[Bolna] template read-back failed for agent ${id}: ${got.error}`);
    return { ok: false, error: got.error };
  }
  if (!extractSystemPrompts(got.agent).includes(template)) {
    logger.error(
      `[Bolna] template did not stick on agent ${id} (fp=${fp}); refusing to dial on an unverified prompt`
    );
    return { ok: false, error: 'Agent prompt did not match the template after PATCH.' };
  }

  confirmed.set(id, fp);
  logger.info(`[Bolna] static prompt template confirmed live on agent ${id} (fp=${fp})`);
  return { ok: true, cached: false };
}

/** Test seam: forget what has been confirmed. */
export function resetAgentPromptCache() {
  confirmed.clear();
}
