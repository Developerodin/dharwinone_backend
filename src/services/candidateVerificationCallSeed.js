import { seedRecord } from './callSync.service.js';

/**
 * Args for CallRecord seeding after a candidate verification dial.
 * agentId is BOLNA_CANDIDATE_AGENT_ID (shared template agent).
 */
export function candidateVerificationSeedBody(result, extras = {}) {
  return {
    executionId: result?.executionId,
    candidate: extras.candidateId || result?.candidateId || null,
    job: extras.jobId || null,
    purpose: 'job_application_verification',
    agentId: result?.agentId || extras.agentId,
    recipientPhone: extras.recipientPhone,
    businessName: extras.businessName || result?.candidateName,
    createdBy: extras.createdBy || null,
    requestId: extras.requestId || null,
    candidateId: result?.candidateId || extras.candidateId,
    candidateName: result?.candidateName || extras.businessName,
    promptRenderToken: result?.promptRenderToken,
    promptHash: result?.promptHash,
    question1: result?.question1,
    ownedClone: result?.ownedClone === true,
    agentVersionId: result?.agentVersionId || null,
    promptTextSnapshot: result?.promptTextSnapshot || null,
    cloneRequestSnapshot: result?.cloneRequestSnapshot || null,
  };
}

/** executionId exists only after POST /call returns, so the insert is in the same turn as the dial. */
export async function seedCandidateVerificationCall(body) {
  if (!body?.executionId) return null;
  return seedRecord(body);
}
