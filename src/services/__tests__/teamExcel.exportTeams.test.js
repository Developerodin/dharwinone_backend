import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { buildExportWorkbookBuffer, _defangCell } from '../teamExcel.service.js';

const team = {
  name: 'Alpha', teamLead: { fullName: 'Lana', email: 'l@x.com' },
  department: 'Engg', description: 'd',
};
const member = {
  employeeId: { _id: 'o1', employeeId: 'DBS101', fullName: 'Asha', email: 'a@x.com', isActive: true },
  seniority: 'Lead', assignmentMode: 'manual', createdAt: '2026-05-01T00:00:00Z',
};

test('buildExportWorkbookBuffer produces single Teams sheet with all columns and A1 active count', () => {
  const buf = buildExportWorkbookBuffer({ teams: [team], membersByTeam: { Alpha: [member] }, activeCount: 1 });
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  assert.equal(sheet.A1.v, 'Active Member Count: 1');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(aoa[2], [
    'Team Name', 'Team Lead Name', 'Team Lead Email', 'Department', 'Description',
    'Employee Internal ID', 'Employee ID', 'Employee Email', 'Employee Name',
    'Team Seniority', 'Active', 'Source', 'Joined',
  ]);
  assert.equal(aoa[3][0], 'Alpha');
  assert.equal(aoa[3][1], 'Lana');   // Team Lead Name — derived from teamLead.fullName
  assert.equal(aoa[3][7], 'a@x.com');
  assert.equal(aoa[3][8], 'Asha');   // Employee Name — derived from employeeId.fullName
  assert.equal(aoa[3][10], 'Yes');
});

test('_defangCell prepends single-quote to formula-prefix values', () => {
  assert.equal(_defangCell('=cmd|...'), "'=cmd|...");
  assert.equal(_defangCell('+1234'),    "'+1234");
  assert.equal(_defangCell('-9'),       "'-9");
  assert.equal(_defangCell('@foo'),     "'@foo");
  assert.equal(_defangCell('Asha'),     'Asha');
  assert.equal(_defangCell(null),       '');
});
