import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { parseWorkbook, REQUIRED_HEADERS, MAX_ROWS_PER_IMPORT } from '../teamExcel.service.js';
import ApiError from '../../utils/ApiError.js';

const xlsxBuffer = (aoa) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Teams');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

test('parseWorkbook returns rows on valid file', () => {
  const buf = xlsxBuffer([
    ['Team Name', 'Employee Email'],
    ['Alpha', 'a@x.com'],
  ]);
  const { rows } = parseWorkbook(buf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Team Name'], 'Alpha');
});

test('parseWorkbook throws 400 on missing Team Name header', () => {
  const buf = xlsxBuffer([['Employee Email'], ['a@x.com']]);
  assert.throws(
    () => parseWorkbook(buf),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('parseWorkbook throws 400 on empty sheet', () => {
  const buf = xlsxBuffer([]);
  assert.throws(
    () => parseWorkbook(buf),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('REQUIRED_HEADERS contains "Team Name"', () => {
  assert.ok(REQUIRED_HEADERS.includes('Team Name'));
});

test('parseWorkbook throws 400 row_limit_exceeded over 5000 rows', () => {
  const aoa = [['Team Name'], ...Array.from({ length: 5001 }, (_, i) => [`Team ${i}`])];
  const buf = xlsxBuffer(aoa);
  assert.throws(
    () => parseWorkbook(buf),
    (err) =>
      err instanceof ApiError &&
      err.statusCode === 400 &&
      err.errors?.[0]?.type === 'row_limit_exceeded'
  );
});

test('MAX_ROWS_PER_IMPORT is 5000', () => {
  assert.equal(MAX_ROWS_PER_IMPORT, 5000);
});
