import { buildSingleSheetBuffer, fmtDate } from './xlsxWorkbook.js';

const EVALUATION_HEADERS = [
  'User',
  'Course',
  'Position',
  'Categories',
  'Completion %',
  'Status',
  'Quiz Avg',
  'Quiz Best',
  'Essay',
  'Certificate',
  'At Risk',
  'Last Accessed',
  'Completed At',
];

function atRiskLabel(reason) {
  if (reason === 'not_started') return 'Not started';
  if (reason === 'stale') return 'Stale activity';
  if (reason === 'no_activity') return 'No activity';
  return 'At risk';
}

/**
 * @param {Array<Record<string, any>>} rows
 * @returns {Buffer}
 */
export function buildEvaluationExportBuffer(rows = []) {
  const dataRows = rows.map((row) => [
    row.studentName || '',
    row.courseName || '',
    row.positionName || '',
    (row.categoryNames || []).join('; '),
    row.completionRate ?? 0,
    row.displayStatus || row.status || '',
    row.quizScore ?? '',
    row.quizScoreBest ?? '',
    row.essayScore ?? '',
    row.certificateIssued ? 'Yes' : 'No',
    row.atRisk ? atRiskLabel(row.atRiskReason) : 'No',
    fmtDate(row.lastAccessedAt),
    fmtDate(row.completedAt),
  ]);
  return buildSingleSheetBuffer('Evaluation', EVALUATION_HEADERS, dataRows);
}
