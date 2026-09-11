import crypto from 'node:crypto';
import logger from '../config/logger.js';

/**
 * Push a prompt template onto a Bolna agent and prove the agent is serving THAT copy.
 *
 * The template itself is static — per-call values travel in `user_data` and Bolna fills the
 * {placeholders}. That part is correct and stays.
 *
 * What is NOT enough is PATCHing byte-identical bytes and reading them back. Bolna caches
 * the RESOLVED system prompt per agent, and the cache key follows the prompt content. Send
 * the same template every call and the key never changes, so Bolna keeps serving the first
 * resolution it made — the job or candidate from whenever that was. Observed live: a call on
 * 2026-09-11 carrying correct `user_data` for one listing read out the title and employer of
 * a different listing, last dialled 2026-09-07. The stored prompt was clean and the read-back
 * passed the whole time; only the resolved copy was stale.
 *
 * So every sync appends a unique `renderToken`. Two things follow, and both are the point:
 *   1. The content differs every call, so Bolna cannot serve a cached resolution.
 *   2. Polling until the token appears proves THIS prompt is live, not merely stored.
 *
 * `bolnaCandidateVerification.service.js` reached the same conclusion independently after the
 * agent greeted a previous candidate; this is that approach, generalised so both agents share
 * one implementation.
 *
 * Two rules from the Bolna API, both learned the hard way:
 *   - A `200 {"state":"updated"}` proves nothing. Always read the agent back.
 *   - `agent_config` maps only to TOP-LEVEL agent fields, which is why the welcome message
 *     can ride along here but `task_config` cannot be set this way at all.
 *
 * Returns `{ ok: false }` when the prompt could not be confirmed live. Callers MUST NOT dial
 * in that case: the agent may still be resolving somebody else's job or candidate.
 *
 * The ceiling: the token defeats Bolna's cache, not a second writer. Another process dialling
 * the same agent still races this one between the poll and the dial, and per-process
 * serialisation cannot fix that. Give each environment its own agent ids.
 */

/** Poll budget for "is the prompt I just wrote the one the agent serves?". */
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_POLL_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * @returns {Promise<{ ok: boolean, renderToken?: string, error?: string }>}
 */
export async function ensureAgentPrompt(deps, agentId, template, welcomeTemplate) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: 'agentId is required.' };
  if (!template) return { ok: false, error: 'template is required.' };

  // Appended, not interpolated: the template's own {placeholders} stay untouched, and an
  // HTML comment is inert to the model. Its only job is to make the bytes unique.
  const renderToken = `render-${crypto.randomUUID()}`;
  const prompt = `${template}\n\n<!-- ${renderToken} -->`;

  const patch = await deps.updateAgentPrompt(id, prompt, {
    agentWelcomeMessage: welcomeTemplate,
  });
  if (!patch.success) {
    logger.error(`[Bolna] prompt PATCH failed for agent ${id} (token=${renderToken}): ${patch.error}`);
    return { ok: false, error: patch.error };
  }

  // A 200 means accepted, not live. Poll until the agent hands back our own token.
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
    const got = await deps.getAgent(id);
    if (got.success && extractSystemPrompts(got.agent).some((p) => p.includes(renderToken))) {
      if (attempt > 1) {
        logger.info(`[Bolna] prompt live on agent ${id} after ${attempt} attempts (token=${renderToken})`);
      }
      return { ok: true, renderToken };
    }
    if (!got.success) {
      logger.warn(`[Bolna] prompt read-back failed for agent ${id} (attempt ${attempt}): ${got.error}`);
    }
    if (attempt < VERIFY_MAX_ATTEMPTS) await sleep(VERIFY_POLL_MS);
  }

  logger.error(
    `[Bolna] prompt did not go live on agent ${id} within ${VERIFY_MAX_ATTEMPTS} attempts ` +
      `(token=${renderToken}); refusing to dial on an unverified prompt`
  );
  return { ok: false, error: 'Patched prompt did not become live in time.' };
}
