import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';

const jobs = [
  {
    title: 'Senior Backend Engineer',
    organisation: { name: 'Acme Corp', website: 'https://acme.example', email: 'hr@acme.example', phone: '9876543210', address: '123 Main St' },
    jobType: 'Full-time',
    location: 'Bengaluru, KA',
    skillTags: ['Node.js', 'MongoDB'],
    jobDescription: 'Build things.',
    salaryRange: { min: 80000, max: 120000, currency: 'INR' },
    experienceLevel: 'Senior Level',
    status: 'Active',
    templateId: { name: 'Standard Eng' },
    createdBy: { name: 'Sarah Johnson' },
    createdAt: '2026-01-20T09:00:00.000Z',
    updatedAt: '2026-02-01T10:30:00.000Z',
  },
  {
    title: '=HYPERLINK("http://evil.example")',
    jobType: 'Contract',
    location: 'Remote',
    status: 'Draft',
    createdAt: null,
    updatedAt: null,
  },
];

let exportJobsToExcel;

before(async () => {
  mock.module('../../models/job.model.js', {
    defaultExport: {
      find: () => ({
        populate() { return this; },
        sort: () => jobs,
      }),
    },
  });
  ({ exportJobsToExcel } = await import('../job.service.js'));
});

const exportBuffer = () => exportJobsToExcel({ platformSuperUser: true });

test('jobs export: header on row 1, columns aligned, autofilter over full range', async () => {
  const wb = XLSX.read(await exportBuffer(), { type: 'buffer' });
  const ws = wb.Sheets.Jobs;

  assert.equal(ws.A1.v, 'Job Title');
  assert.equal(ws.B1.v, 'Organisation Name');
  assert.equal(ws.S1.v, 'Updated At (UTC)');
  assert.equal(ws.A2.v, 'Senior Backend Engineer');
  assert.equal(ws.B2.v, 'Acme Corp');
  assert.equal(ws.I2.v, 'Node.js; MongoDB');
  assert.equal(ws['!autofilter'].ref, 'A1:S3');
});

test('jobs export: dates readable, formulas defanged, widths fit content', async () => {
  const wb = XLSX.read(await exportBuffer(), { type: 'buffer', cellStyles: true });
  const ws = wb.Sheets.Jobs;

  assert.equal(ws.R2.v, '2026-01-20 09:00');
  assert.equal(ws.A3.v, `'=HYPERLINK("http://evil.example")`);
  assert.ok(ws['!cols'][0].wch >= 'Senior Backend Engineer'.length);
  assert.ok(ws['!cols'].every((c) => c.wch >= 10 && c.wch <= 60));
});
