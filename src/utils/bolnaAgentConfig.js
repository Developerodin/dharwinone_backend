import config from '../config/config.js';
import logger from '../config/logger.js';

export function normalizeBolnaAgentId(id) {
  return String(id ?? '').trim();
}

/** True when job-posting and applicant flows would use the same Bolna agent (unsafe with dynamic applicant prompts). */
export function bolnaJobAndCandidateAgentsCollide() {
  const jobId = normalizeBolnaAgentId(config.bolna.agentId);
  const candId = normalizeBolnaAgentId(config.bolna.candidateAgentId);
  return Boolean(jobId && candId && jobId === candId);
}

export function logBolnaAgentConfigHealth() {
  if (!config.bolna.apiKey) return;
  if (bolnaJobAndCandidateAgentsCollide()) {
    logger.error(
      '[Bolna] BOLNA_AGENT_ID and BOLNA_CANDIDATE_AGENT_ID are identical. ' +
        'Job posting verification uses the job agent without patching; applicant verification PATCHes the full system prompt on the candidate agent. ' +
        'Sharing one agent makes recruiter and applicant calls use the wrong script. ' +
        'Create a second agent in Bolna, set BOLNA_CANDIDATE_AGENT_ID (see BOLNA_MULTI_AGENT_SETUP.md). ' +
        'Applicant verification calls are rejected until the IDs differ.'
    );
  }
}
