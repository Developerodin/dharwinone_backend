import { buildSingleSheetBuffer, fmtDate, fmtDateTime } from './xlsxWorkbook.js';

function formatDurationMs(ms) {
  if (ms == null || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const TRACK_HEADERS = [
  'Name',
  'Employee ID',
  'Email',
  'Status',
  'Punch In (UTC)',
  'Punch Out (UTC)',
  'Duration',
  'Timezone',
];

const HISTORY_HEADERS = [
  'Name',
  'Employee ID',
  'Email',
  'Date',
  'Day',
  'Punch In (UTC)',
  'Punch Out (UTC)',
  'Duration',
  'Timezone',
];

/**
 * @param {Array<Record<string, any>>} rows
 * @returns {Buffer}
 */
export function buildTrackExportBuffer(rows = []) {
  const dataRows = rows.map((row) => [
    row.studentName || '',
    row.employeeId || '',
    row.email || '',
    row.isPunchedIn ? 'Punched In' : 'Punched Out',
    row.punchIn ? fmtDateTime(row.punchIn) : '',
    row.punchOut ? fmtDateTime(row.punchOut) : row.isPunchedIn ? 'In progress' : '',
    row.isPunchedIn ? 'In progress' : formatDurationMs(row.durationMs ?? null),
    row.timezone || 'UTC',
  ]);
  return buildSingleSheetBuffer('Track Attendance', TRACK_HEADERS, dataRows);
}

/**
 * @param {Array<Record<string, any>>} rows
 * @returns {Buffer}
 */
export function buildHistoryExportBuffer(rows = []) {
  const dataRows = rows.map((row) => [
    row.studentName || '',
    row.employeeId || '',
    row.email || '',
    fmtDate(row.date),
    row.day || '',
    row.punchIn ? fmtDateTime(row.punchIn) : '',
    row.punchOut ? fmtDateTime(row.punchOut) : '',
    formatDurationMs(row.durationMs ?? null),
    row.timezone || 'UTC',
  ]);
  return buildSingleSheetBuffer('Attendance History', HISTORY_HEADERS, dataRows);
}
