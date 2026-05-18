import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { buildTemplateWorkbookBuffer } from '../teamExcel.service.js';

test('template contains canonical headers + 2 example rows', () => {
  const buf = buildTemplateWorkbookBuffer();
  const wb = XLSX.read(buf, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  assert.deepEqual(aoa[0], [
    'Team Name', 'Team Lead Email', 'Department', 'Description',
    'Employee Internal ID', 'Employee ID', 'Employee Email', 'Employee Name', 'Team Seniority',
  ]);
  assert.equal(aoa.length, 3);
});
