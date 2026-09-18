/**
 * Pure planner for candidate interview data erasure (DSR). Executor is idempotent.
 * @param {object} facts
 * @returns {{ deletions: Array<{ kind: string, id: string }> }}
 */
export function planCandidateErasure(facts = {}) {
  const deletions = [];
  const push = (kind, id) => {
    if (id) deletions.push({ kind, id: String(id) });
  };
  for (const meetingId of facts.meetingIds || []) push('meeting', meetingId);
  for (const recordingId of facts.recordingIds || []) push('recording', recordingId);
  for (const sessionId of facts.transcriptSessionIds || []) push('transcriptSession', sessionId);
  for (const versionId of facts.transcriptVersionIds || []) push('transcriptVersion', versionId);
  if (facts.summaryMeetingId) push('summary', facts.summaryMeetingId);
  // biasCheck is embedded on Meeting (select:false). Deleting the meeting covers it — no extra kind.
  return { deletions };
}
