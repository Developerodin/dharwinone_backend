import XLSX from 'xlsx';
import { defangCell, fmtDateTime } from './xlsxWorkbook.js';

const ACTIVITY_LOG_HEADERS = [
  'Timestamp',
  'Actor',
  'Actor Email',
  'Action',
  'Action Code',
  'Entity Type',
  'Location',
  'IP Address',
  'User Agent',
];

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
    ['Start date', filter.startDate],
    ['End date', filter.endDate],
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
    row.actionTitle ?? row.action ?? '',
    row.action ?? '',
    row.entityType ?? '',
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
