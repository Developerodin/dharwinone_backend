import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { generateCandidateExportXlsxBuffer } from '../candidateExportXlsx.js';

const exportData = {
  totalCandidates: 1,
  exportedAt: '2026-06-12T00:00:00.000Z',
  data: [
    {
      employeeId: 'DBS101',
      fullName: 'Asha Rao',
      email: 'asha@x.com',
      phoneNumber: '9876543210',
      countryCode: 'IN',
      shortBio: 'bio',
      sevisId: 'SV1',
      visaType: 'H1B',
      supervisorName: 'Sup',
      salaryRange: '10-12',
      designation: 'Engineer',
      isCompleted: true,
      address: { streetAddress: '1 St', city: 'Pune', state: 'MH', zipCode: '411001', country: 'IN' },
      documents: [
        { label: 'Aadhar Card', type: 'Aadhar', url: 'https://x/a.pdf', originalName: 'a.pdf', size: 1024, mimeType: 'application/pdf', status: 1, verifiedAt: '2026-06-10T00:00:00.000Z' },
        { label: '', type: 'PAN', url: '', originalName: 'pan.pdf', size: 0, mimeType: '', status: 2, verifiedAt: '' },
      ],
    },
  ],
};

test('produces one consolidated Employee Details sheet (no separate Visa/Address sheets)', () => {
  const wb = XLSX.read(generateCandidateExportXlsxBuffer(exportData), { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('Employee Details'));
  assert.ok(!wb.SheetNames.includes('Overview'));
  assert.ok(!wb.SheetNames.includes('Visa and supervisor'));
  assert.ok(!wb.SheetNames.includes('Address'));
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Employee Details'], { header: 1 });
  const header = aoa[0];
  assert.ok(header.includes('Visa Type'));
  assert.ok(header.includes('City'));
  assert.equal(aoa[1][header.indexOf('Full Name')], 'Asha Rao');
  assert.equal(aoa[1][header.indexOf('City')], 'Pune');
});

test('Documents sheet lists name, type, and upload status only', () => {
  const wb = XLSX.read(generateCandidateExportXlsxBuffer(exportData), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets.Documents, { header: 1 });
  assert.deepEqual(aoa[0], [
    'Employee ID', 'Full Name', 'Email',
    'Document Name', 'Document Type', 'Upload Status', 'Mime Type',
  ]);
  assert.equal(aoa[1][3], 'Aadhar Card');
  assert.equal(aoa[1][4], 'Aadhar');
  assert.equal(aoa[1][5], 'Uploaded');
  assert.equal(aoa[1][6], 'application/pdf');
  assert.equal(aoa[2][3], 'pan.pdf');
  assert.equal(aoa[2][5], 'Missing');
});

test('Salary Slips sheet omits original filename', () => {
  const wb = XLSX.read(
    generateCandidateExportXlsxBuffer({
      ...exportData,
      data: [{ ...exportData.data[0], salarySlips: [{ month: 'March', year: '2026', originalName: 'slip.pdf' }] }],
    }),
    { type: 'buffer' }
  );
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Salary Slips'], { header: 1 });
  assert.deepEqual(aoa[0], ['Employee ID', 'Full Name', 'Email', 'Month', 'Year']);
  assert.equal(aoa[1][3], 'March');
  assert.equal(aoa[1][4], '2026');
});
