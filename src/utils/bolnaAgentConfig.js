import config from '../config/config.js';
import logger from '../config/logger.js';

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

// The prompt-sync helper that lived here is gone. It memoised a byte-identical PATCH per
// process, which is precisely what let Bolna serve a cached RESOLVED prompt and read out a
// previous candidate's data. Both flows now share the token-verified implementation in
// utils/bolnaAgentTemplateSync.js.

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
