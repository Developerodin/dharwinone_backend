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

/** Format a date value as YYYY-MM-DD (empty string for missing/invalid). */
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

/**
 * Build an in-memory .xlsx workbook of training students.
 *
 * Pure function — no I/O. Each row is one student; `user`, `position`, and
 * `shift` are expected to be populated (falls back to empty cells otherwise).
 *
 * @param {Array<Record<string, any>>} students
 * @returns {Buffer}
 */
export function buildStudentsExportBuffer(students = []) {
  const headers = [
    'Name', 'Email', 'Phone', 'Gender', 'Date of Birth', 'Position',
    'Status', 'Shift', 'Joining Date', 'City', 'State', 'Country',
    'Skills', 'Created At',
  ];
  const aoa = [[`Total Students: ${students.length}`], [], headers];
  for (const s of students) {
    const user = s.user || {};
    const addr = s.address || {};
    aoa.push(
      [
        user.name || '',
        user.email || '',
        s.phone || '',
        s.gender || '',
        fmtDate(s.dateOfBirth),
        s.position?.name || '',
        s.status || '',
        s.shift?.name || '',
        fmtDate(s.joiningDate),
        addr.city || '',
        addr.state || '',
        addr.country || '',
        Array.isArray(s.skills) ? s.skills.join(', ') : '',
        fmtDate(s.createdAt),
      ].map(defangCell)
    );
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
