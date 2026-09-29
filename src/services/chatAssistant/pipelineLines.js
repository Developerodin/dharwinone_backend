/** Row formatters for Sage pipeline tool output. Pure — the LLM sees exactly this text. */
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
