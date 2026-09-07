import XLSX from 'xlsx';
import { defangCell, fmtDateTime } from './xlsxWorkbook.js';

const ACTIVITY_LOG_HEADERS = [
  // Timestamps come from fmtDateTime, which is UTC. The screen shows the viewer's local time,
  // so an unlabelled column here reads as the same event happening hours earlier.
  'Timestamp (UTC)',
  'Actor',
  'Actor Email',
  'Action',
  'Action Code',
  'Entity Type',
  'Entity Name',
  'Entity ID',
  'Location',
  'IP Address',
  'User Agent',
];

/**
 * Stored entity types the sheet renames on the way out, so a download reads the same as the screen.
 * "Candidate" is the pre-rename spelling of an employee record; both spellings are still written.
 */
const ENTITY_TYPE_LABELS = { Candidate: 'Employee' };

/**
 * Display name of a stored entity type.
 * @param {unknown} entityType
 * @returns {string}
 */
export function entityTypeLabel(entityType) {
  const t = typeof entityType === 'string' ? entityType.trim() : '';
  return t ? ENTITY_TYPE_LABELS[t] ?? t : '';
}

/** Metadata keys that hold a human name for the affected record, best first. */
const ENTITY_NAME_KEYS = ['targetUserName', 'roleName', 'fullName', 'name', 'jobTitle', 'title'];

/**
 * Human name of the record an entry touched, or '' when the entry carries none.
 * @param {unknown} metadata
 * @returns {string}
 */
export function pickEntityName(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  for (const key of ENTITY_NAME_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Human title for a dotted action code: `attendance.punchOutByAdmin` → `Attendance punch out by admin`.
 *
 * ponytail: derived, not a curated map. The frontend keeps ~200 hand-written titles and a second
 * copy here would drift the moment either side gains an action. Derivation is never wrong, only
 * blunter. Port the map if the wording ever has to match the screen word for word.
 * @param {string} action
 * @returns {string}
 */
export function humanizeActionCode(action) {
  const code = typeof action === 'string' ? action.trim() : '';
  if (!code) return '';
  const words = code
    .split('.')
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/))
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (!words.length) return '';
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * @param {Record<string, unknown>} filter
 * @returns {Array<[string, string]>}
 */
export function buildActivityLogFilterMetaRows(filter = {}) {
  const rows = [['Filter', 'Value']];
  const entries = [
    ['Search (q)', filter.q],
    ['Action', filter.action],
    ['Entity type', filter.entityType],
    ['Entity id', filter.entityId],
    ['Actor', filter.actor],
    ['Start date (UTC)', filter.startDate],
    ['End date (UTC)', filter.endDate],
    ['IP', filter.ip],
    ['Include attendance', filter.includeAttendance],
  ];
  for (const [label, value] of entries) {
    if (value != null && String(value).trim() !== '') {
      rows.push([label, String(value)]);
    }
  }
  if (rows.length === 1) rows.push(['Filters', 'None (all accessible activity logs)']);
  return rows;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, unknown>} [filter]
 * @returns {Buffer}
 */
export function buildActivityLogExportBuffer(rows = [], filter = {}) {
  const dataRows = rows.map((row) => [
    fmtDateTime(row.createdAt),
    row.actorName ?? '',
    row.actorEmail ?? '',
    row.actionTitle ?? humanizeActionCode(row.action),
    row.action ?? '',
    entityTypeLabel(row.entityType),
    row.entityName ?? pickEntityName(row.metadata),
    row.entityId ?? '',
    row.displayLocation ?? '',
    row.displayIp ?? '',
    row.userAgent ?? '',
  ]);

  const mainAoa = [ACTIVITY_LOG_HEADERS, ...dataRows.map((row) => row.map(defangCell))];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(mainAoa);

  ws['!cols'] = ACTIVITY_LOG_HEADERS.map((h, col) => {
    const longest = mainAoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, h.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });

  const lastCol = XLSX.utils.encode_col(ACTIVITY_LOG_HEADERS.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${mainAoa.length}` };

  XLSX.utils.book_append_sheet(wb, ws, 'Activity Logs');

  const metaRows = buildActivityLogFilterMetaRows(filter).map((row) => row.map(defangCell));
  const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
  metaWs['!cols'] = [{ wch: 24 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, metaWs, 'Export filters');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
