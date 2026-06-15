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
  const aoa = [[`Total Interviews: ${meetings.length}`], [], headers];
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
        m.status || '',
        m.interviewResult || '',
        fmtDateTime(m.createdAt),
        m.publicMeetingUrl || '',
      ].map(defangCell)
    );
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Interviews');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
