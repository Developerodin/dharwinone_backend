import XLSX from 'xlsx';

/**
 * Defang a cell against CSV/Excel formula injection. A leading =, +, -, or @
 * is prefixed with a single quote so spreadsheet apps treat it as text.
 * @param {*} v
 * @returns {string}
 */
function defangCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** Format a date value as "YYYY-MM-DD HH:mm" UTC (empty for missing/invalid). */
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 16).replace('T', ' ');
}

const STATUS_LABELS = {
  scheduled: 'Scheduled',
  'in progress': 'In Progress',
  inprogress: 'In Progress',
  ended: 'Completed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
};

/** Human-readable status label aligned with the Interviews table UI. */
function formatStatusLabel(status) {
  const raw = String(status || '').toLowerCase();
  if (!raw) return 'Scheduled';
  return STATUS_LABELS[raw] || status;
}

/** Human-readable result label aligned with the Interviews table UI. */
function formatResultLabel(result) {
  if (result === 'selected') return 'Selected';
  if (result === 'rejected') return 'Rejected';
  return 'Pending';
}

/**
 * Build an in-memory .xlsx workbook of ATS interviews (Meeting docs).
 *
 * Pure function — no I/O. Candidate / recruiter are embedded snapshots on the
 * meeting, so no population is required.
 *
 * @param {Array<Record<string, any>>} meetings
 * @returns {Buffer}
 */
export function buildMeetingsExportBuffer(meetings = []) {
  const headers = [
    'Title', 'Candidate Name', 'Candidate Email', 'Candidate Phone',
    'Job Position', 'Interview Type', 'Recruiter Name', 'Recruiter Email',
    'Scheduled At (UTC)', 'Duration (min)', 'Status', 'Result',
    'Created At (UTC)', 'Meeting Link',
  ];
  // Header on row 1 (no banner/blank offset) so sort, filter, and freeze work.
  const aoa = [headers];
  for (const m of meetings) {
    const c = m.candidate || {};
    const r = m.recruiter || {};
    aoa.push(
      [
        m.title || '',
        c.name || '',
        c.email || '',
        c.phone || '',
        m.jobPosition || '',
        m.interviewType || '',
        r.name || '',
        r.email || '',
        fmtDateTime(m.scheduledAt),
        m.durationMinutes ?? '',
        formatStatusLabel(m.status),
        formatResultLabel(m.interviewResult),
        fmtDateTime(m.createdAt),
        m.publicMeetingUrl || '',
      ].map(defangCell)
    );
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Size each column to its longest value (clamped 10..60) so nothing truncates.
  ws['!cols'] = headers.map((h, col) => {
    const longest = aoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, h.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });
  // Enable filter dropdowns on the header row. (Freeze panes aren't emitted by
  // the community xlsx writer, so we don't set !freeze — it would be dead code.)
  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${aoa.length}` };

  XLSX.utils.book_append_sheet(wb, ws, 'Interviews');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
