import crypto from 'crypto';
import config from '../config/config.js';
import logger from '../config/logger.js';
import bolnaService from '../services/bolna.service.js';

export function normalizeBolnaAgentId(id) {
  return String(id ?? '').trim();
}

/**
 * Names every {placeholder} the template expects but user_data does not usefully supply.
 *
 * Bolna renders an unresolved single-brace {var} as EMPTY, silently — a missing
 * candidate name turns Question 1 into a blank line the agent then improvises around.
 * An EMPTY value renders identically, so a key that merely exists is not enough: both
 * flows build template and vars in the same module, so a presence-only check could never
 * fire for the failure it was written to catch.
 *
 * `allowEmpty` names the keys that are legitimately blank — measured against live data,
 * that is only `additional_instructions` (empty on 60/60 applications; the job flow has
 * none). Anything else rendering empty is a bug we want to hear about before dialling.
 */
export function missingTemplateVars(template, vars, { allowEmpty = [] } = {}) {
  const optional = new Set(allowEmpty);
  const needed = new Set();
  for (const m of String(template).matchAll(/\{(\w+)\}/g)) needed.add(m[1]);
  return [...needed].filter((k) => {
    if (!(k in vars)) return true;
    if (optional.has(k)) return false;
    return String(vars[k] ?? '') === '';
  });
}

/** agentId -> fingerprint of the prompt+greeting last known to be live on that agent. */
const patchedByAgent = new Map();

/**
 * Put the static prompt on the agent, but only when it is not already there.
 *
 * The prompt is byte-identical on every call now that per-call data travels in
 * `user_data`, so PATCHing before each dial spent ~1.1s rewriting bytes the agent
 * already had, on the mandatory path of every call.
 *
 * A failure is usually NOT fatal — but only once we have seen this process patch the
 * agent successfully at least once. After that the prompt is a constant the agent
 * already holds, so refusing to dial over a failed rewrite of unchanged bytes trades a
 * working call for no call.
 *
 * Before that first success the assumption does not hold. On the first call after a
 * deploy the agent may still carry the OLD fully-resolved prompt, with a previous
 * candidate's name baked in and no {placeholders} for user_data to fill. Dialling then
 * reproduces exactly the wrong-candidate bug this refactor exists to remove, so a
 * failure in that window is reported as `fatal` and the caller must not dial.
 *
 * ponytail: per-process memo. A hand edit in the Bolna canvas is repaired on the next
 * deploy or restart rather than the next call. Restart to force it.
 *
 * @returns {Promise<{ patched: boolean, fatal?: boolean, error?: string }>}
 */
export async function ensureAgentPrompt({ agentId, systemPrompt, welcomeMessage = '' }) {
  if (!agentId) {
    // Without this, every mis-configured caller shares one `undefined` memo slot and the
    // first success would mark all of them clean.
    return { patched: false, fatal: true, error: 'ensureAgentPrompt called without an agentId' };
  }

  const fingerprint = crypto
    .createHash('sha1')
    .update(systemPrompt, 'utf8')
    .update(' ')
    .update(welcomeMessage, 'utf8')
    .digest('hex');

  if (patchedByAgent.get(agentId) === fingerprint) return { patched: false };

  const res = await bolnaService.updateAgentPrompt(agentId, systemPrompt, {
    agentWelcomeMessage: welcomeMessage,
  });

  if (!res.success) {
    const neverPatched = !patchedByAgent.has(agentId);
    if (neverPatched) {
      logger.error(
        `[Bolna] agent ${agentId} prompt sync failed and this process has never patched it: ${res.error}. ` +
          'Not dialling — the agent may still hold a previous prompt with another candidate baked in.'
      );
      return { patched: false, fatal: true, error: res.error };
    }
    logger.warn(
      `[Bolna] agent ${agentId} prompt sync failed: ${res.error}. ` +
        'Dialling anyway — this process already put the current prompt on the agent. ' +
        'Will retry on the next call.'
    );
    return { patched: false, error: res.error };
  }

  patchedByAgent.set(agentId, fingerprint);
  return { patched: true };
}

/** True when job-posting and applicant flows would use the same Bolna agent (unsafe with dynamic applicant prompts). */
export function bolnaJobAndCandidateAgentsCollide() {
  const jobId = normalizeBolnaAgentId(config.bolna.agentId);
  const candId = normalizeBolnaAgentId(config.bolna.candidateAgentId);
  return Boolean(jobId && candId && jobId === candId);
}

export function logBolnaAgentConfigHealth() {
  if (!config.bolna.apiKey) return;
  const jobId = normalizeBolnaAgentId(config.bolna.agentId);
  const candId = normalizeBolnaAgentId(config.bolna.candidateAgentId);
  if (!jobId) {
    logger.error('[Bolna] BOLNA_AGENT_ID is not set. Job posting verification calls will fail.');
  }
  if (!candId) {
    logger.error('[Bolna] BOLNA_CANDIDATE_AGENT_ID is not set. Applicant verification calls will fail.');
  }
  if (bolnaJobAndCandidateAgentsCollide()) {
    logger.error(
      '[Bolna] BOLNA_AGENT_ID and BOLNA_CANDIDATE_AGENT_ID are identical. ' +
        'Job posting verification uses the job agent without patching; applicant verification PATCHes the full system prompt on the candidate agent. ' +
        'Sharing one agent makes recruiter and applicant calls use the wrong script. ' +
        'Create a second agent in Bolna, set BOLNA_CANDIDATE_AGENT_ID (see docs/BOLNA.md). ' +
        'Applicant verification calls are rejected until the IDs differ.'
    );
  }
}
