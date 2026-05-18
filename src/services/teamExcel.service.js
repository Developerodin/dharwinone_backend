import XLSX from 'xlsx';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

export const REQUIRED_HEADERS = ['Team Name'];
export const MAX_ROWS_PER_IMPORT = 5000;

/**
 * Parse an uploaded Excel workbook buffer for the Teams bulk import flow.
 *
 * Validates:
 *  - workbook contains at least one sheet
 *  - first sheet has at least one data row
 *  - row count does not exceed MAX_ROWS_PER_IMPORT (5000)
 *  - required headers (REQUIRED_HEADERS) are present on row 1
 *
 * Throws ApiError(400) with a structured `errors[]` describing the violation.
 * @param {Buffer} buffer raw xlsx file bytes
 * @returns {{ rows: Array<Record<string, any>> }}
 */
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (!wb.SheetNames.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'empty_sheet' },
    ]);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'empty_sheet' },
    ]);
  }
  if (rows.length > MAX_ROWS_PER_IMPORT) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined, [
      { type: 'row_limit_exceeded', limit: MAX_ROWS_PER_IMPORT, received: rows.length },
    ]);
  }
  const headers = Object.keys(rows[0] || {});
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Invalid Excel file',
      false,
      undefined,
      missing.map((header) => ({ type: 'missing_header', header }))
    );
  }
  return { rows };
}
