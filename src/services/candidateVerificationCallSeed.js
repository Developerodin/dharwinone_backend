import { seedRecord } from './callSync.service.js';

/**
 * Args for CallRecord seeding after a candidate verification dial.
 * agentId is the clone. Never the template id.
 */
export function candidateVerificationSeedBody(result, extras = {}) {
  return {
    executionId: result?.executionId,
    candidate: extras.candidateId || result?.candidateId || null,
    job: extras.jobId || null,
    purpose: 'job_application_verification',
    agentId: result?.agentId,
    recipientPhone: extras.recipientPhone,
    businessName: extras.businessName || result?.candidateName,
    createdBy: extras.createdBy || null,
    requestId: extras.requestId || null,
    candidateId: result?.candidateId || extras.candidateId,
    candidateName: result?.candidateName || extras.businessName,
    promptRenderToken: result?.promptRenderToken,
    promptHash: result?.promptHash,
    question1: result?.question1,
    ownedClone: true,
  };
}

/** executionId exists only after POST /call returns, so the insert is in the same turn as the dial. */
export async function seedCandidateVerificationCall(body) {
  if (!body?.executionId) return null;
  return seedRecord(body);
}
