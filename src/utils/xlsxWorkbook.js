import XLSX from 'xlsx';

/** A leading =, +, -, or @ is quoted so Excel treats the cell as text, not a formula. */
export function defangCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** Format a date value as "YYYY-MM-DD HH:mm" UTC (empty for missing/invalid). */
export function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 16).replace('T', ' ');
}

/** Date-only UTC column. */
export function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

/**
 * Build a single-sheet .xlsx buffer with autofilter and column sizing.
 *
 * @param {string} sheetName
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @returns {Buffer}
 */
export function buildSingleSheetBuffer(sheetName, headers, rows = []) {
  const aoa = [headers, ...rows.map((row) => row.map(defangCell))];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = headers.map((h, col) => {
    const longest = aoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, h.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });

  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${aoa.length}` };

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
