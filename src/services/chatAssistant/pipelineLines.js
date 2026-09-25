/** Row formatters for Sage pipeline tool output. Pure — the LLM sees exactly this text. */
const NR = 'NOT_RECORDED';
const daysSince = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

export function formatOfferLine(o, { fmtDate }) {
  const cand = o.candidate?.owner?.name ?? o.candidate?.fullName ?? 'N/A';
  const email = o.candidate?.owner?.email ?? 'N/A';
  const empId = o.candidate?.employeeId ?? 'N/A';
  const ctc = o.ctcBreakdown?.gross ? `${o.ctcBreakdown.gross} ${o.ctcBreakdown.currency || ''}`.trim() : 'N/A';
  const parts = [
    `OFFER: ${o.offerCode || 'N/A'}`,
    `CANDIDATE: ${cand} (${empId})`,
    `EMAIL: ${email}`,
    `JOB: ${o.job?.title ?? 'N/A'}`,
    `POSITION: ${o.positionTitle || o.job?.title || 'N/A'}`,
    `STATUS: ${o.status || 'N/A'}`,
    `JOINING: ${fmtDate(o.joiningDate) || 'N/A'}`,
    `CTC: ${ctc}`,
    `PREPARED: ${fmtDate(o.createdAt) || NR}${o.createdBy?.name ? ` by ${o.createdBy.name}` : ''}`,
    `SENT: ${fmtDate(o.sentAt) || NR}`,
  ];
  if (o.acceptedAt) parts.push(`ACCEPTED: ${fmtDate(o.acceptedAt)}`);
  if (o.rejectedAt) parts.push(`REJECTED: ${fmtDate(o.rejectedAt)}`);
  if (o.status === 'Sent' && o.sentAt) parts.push(`PENDING_DAYS: ${daysSince(o.sentAt)}`);
  if (o.offerLetterGeneratedAt) parts.push(`PDF_GENERATED: ${fmtDate(o.offerLetterGeneratedAt)}`);
  if (o.offerLetterUrl) parts.push(`LETTER: ${o.offerLetterUrl}`);
  if (o.rejectionReason) parts.push(`REJECT_REASON: ${o.rejectionReason}`);
  return parts.join(' | ');
}

export function formatPlacementLine(p, { fmtDate }) {
  const cand = p.candidate?.owner?.name ?? p.candidate?.fullName ?? 'N/A';
  const empId = p.employeeId ?? p.candidate?.employeeId ?? 'N/A';
  const parts = [
    `PLACEMENT: ${p.offer?.offerCode || 'N/A'}`,
    `CANDIDATE: ${cand} (${empId})`,
    `JOB: ${p.job?.title ?? 'N/A'}`,
    `STATUS: ${p.status || 'N/A'}`,
    `PRE_BOARDING: ${p.preBoardingStatus || 'N/A'}`,
    `JOINING_DATE: ${fmtDate(p.joiningDate) || 'N/A'}`,
    `JOINED_AT: ${fmtDate(p.joinedAt) || '—'}`,
  ];
  const bgv = p.backgroundVerification;
  if (bgv?.status) {
    const when = [
      bgv.requestedAt && `requested ${fmtDate(bgv.requestedAt)}`,
      bgv.completedAt && `completed ${fmtDate(bgv.completedAt)}`,
    ].filter(Boolean).join(', ');
    parts.push(`BGV: ${bgv.status}${when ? ` (${when})` : ''}`);
  }
  if (p.enteredOnboardingAt) parts.push(`ENTERED_ONBOARDING: ${fmtDate(p.enteredOnboardingAt)}`);
  if (p.onboardingCompletedAt) parts.push(`ONBOARDING_COMPLETED: ${fmtDate(p.onboardingCompletedAt)}`);
  return parts.join(' | ');
}

const nameOf = (u) => (u && typeof u === 'object' ? u.name : u) || null;

export function formatTaskLine(t, { fmtDate }) {
  const assignees = Array.isArray(t.assignedTo) && t.assignedTo.length
    ? t.assignedTo.map(nameOf).filter(Boolean).join(', ')
    : 'Unassigned';
  const project = typeof t.projectId === 'object' ? (t.projectId?.name || '') : '';
  const comments = Array.isArray(t.comments) ? t.comments : [];
  const last = comments[comments.length - 1];
  const desc = (t.description || '').trim();
  const parts = [
    `TASK: ${t.title || 'N/A'}`,
    `CODE: ${t.taskCode || 'N/A'}`,
    `STATUS: ${t.status || 'N/A'}`,
    `CREATED: ${fmtDate(t.createdAt) || 'N/A'}`,
    `UPDATED: ${fmtDate(t.updatedAt) || 'N/A'}`,
    `DUE: ${fmtDate(t.dueDate) || 'No deadline'}`,
    `ASSIGNED_TO: ${assignees}`,
    `CREATED_BY: ${nameOf(t.createdBy) || 'N/A'}`,
  ];
  if (project) parts.push(`PROJECT: ${project}`);
  if (Array.isArray(t.tags) && t.tags.length) parts.push(`TAGS: ${t.tags.join(', ')}`);
  if (desc) parts.push(`DESCRIPTION: ${desc.length > 200 ? `${desc.slice(0, 200)}…` : desc}`);
  parts.push(`COMMENTS: ${comments.length}`);
  parts.push(
    last
      ? `LAST_COMMENT: "${String(last.content).slice(0, 200)}" — ${nameOf(last.commentedBy) || 'unknown'}, ${fmtDate(last.createdAt) || '?'}`
      : 'LAST_COMMENT: NOT_RECORDED'
  );
  return parts.join(' | ');
}
