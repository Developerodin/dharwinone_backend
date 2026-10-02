/**
 * Fields written when we seed a CallRecord after a successful Bolna POST /call.
 * Pure: no Mongo. createRecord persists this object.
 *
 * Candidate verification passes agentId (the isolated agent), candidateId,
 * candidateName, promptRenderToken, promptHash, and question1. Other callers
 * omit them; those keys stay off the document.
 */
export function initiateCallRecordDoc(body) {
  if (!body?.executionId) return null;
  const doc = {
    executionId: String(body.executionId),
    recipientPhoneNumber: body.recipientPhone ? String(body.recipientPhone) : undefined,
    toPhoneNumber: body.recipientPhone ? String(body.recipientPhone) : undefined,
    phone: body.recipientPhone ? String(body.recipientPhone) : undefined,
    businessName: body.recipientName ? String(body.recipientName).trim() : undefined,
    purpose: body.purpose ? String(body.purpose).trim() : undefined,
    job: body.relatedJob || undefined,
    candidate: body.relatedCandidate || undefined,
    status: body.status ? String(body.status) : 'initiated',
  };
  if (body.agentId) doc.agentId = String(body.agentId);
  if (body.candidateId) doc.candidateId = String(body.candidateId);
  else if (body.relatedCandidate != null && String(body.relatedCandidate)) {
    doc.candidateId = String(body.relatedCandidate);
  }
  if (body.candidateName) doc.candidateName = String(body.candidateName).trim();
  if (body.promptRenderToken) doc.promptRenderToken = String(body.promptRenderToken);
  if (body.promptHash) doc.promptHash = String(body.promptHash);
  if (body.question1) doc.question1 = String(body.question1);
  if (body.ownedClone === true || body.promptRenderToken) doc.ownedClone = true;
  return doc;
}
