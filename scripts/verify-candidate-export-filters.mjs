#!/usr/bin/env node
/**
 * Verifies candidate export CSV helpers (RFC 4180-style cells, column parity).
 * Optional: with VERIFY_API_BASE_URL + VERIFY_API_TOKEN, compares GET /candidates totalResults
 * to CSV row count for a filter (same query params).
 *
 * Run: node scripts/verify-candidate-export-filters.mjs
 * API: VERIFY_API_BASE_URL=http://localhost:3000 VERIFY_API_TOKEN=eyJ... node scripts/verify-candidate-export-filters.mjs
 */

/* eslint-disable no-console */

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') {
      cur += '"';
      i += 1;
      continue;
    }
    if (c === '"') {
      inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { csvCell, generateCandidateExportCsv } = await import('../src/utils/candidateExportCsv.js');

  assert(csvCell('a,b') === '"a,b"', 'csvCell should quote commas');
  assert(csvCell('say "hi"') === '"say ""hi"""', 'csvCell should escape quotes');
  assert(csvCell(null) === '""', 'csvCell null');
  assert(csvCell(undefined) === '""', 'csvCell undefined');

  const sample = {
    totalCandidates: 1,
    exportedAt: new Date().toISOString(),
    data: [
      {
        employeeId: 'DBS1',
        fullName: 'Comma, Name',
        email: 'x@y.com',
        phoneNumber: '9191919191',
        countryCode: '+1',
        shortBio: 'Single-line bio (newlines are allowed inside quoted CSV cells)',
        sevisId: '',
        ead: '',
        visaType: 'F-1',
        customVisaType: '',
        degree: 'MS',
        supervisorName: '',
        supervisorContact: '',
        supervisorCountryCode: '',
        salaryRange: '',
        address: {
          streetAddress: '1 Main St, Apt 2',
          streetAddress2: '',
          city: 'Austin',
          state: 'TX',
          zipCode: '78701',
          country: 'US',
        },
        owner: 'Owner Name',
        ownerEmail: 'o@o.com',
        adminId: '',
        adminEmail: '',
        assignedAgentName: 'Agent A',
        assignedAgentEmail: 'a@a.com',
        designation: 'Engineer',
        positionTitle: 'Java Developer',
        isProfileCompleted: 80,
        isCompleted: false,
        createdAt: new Date('2020-01-02'),
        updatedAt: new Date('2020-01-03'),
        qualifications: [{ degree: 'MS', institute: 'U', location: '', startYear: '', endYear: '', description: '' }],
        experiences: [
          {
            company: 'Co, Inc',
            role: 'Dev',
            startDate: '2019-01-01',
            endDate: '',
            description: '',
            currentlyWorking: true,
          },
        ],
        skills: [{ name: 'JS', level: 'Expert', category: '' }],
        socialLinks: [{ platform: 'Li', url: 'https://x.com' }],
        documents: [{ label: 'Doc', url: '', originalName: '', size: '', mimeType: '' }],
        salarySlips: [{ month: 'Jan', year: '2024', documentUrl: '', originalName: '', size: '', mimeType: '' }],
      },
    ],
  };

  const csv = generateCandidateExportCsv(sample);
  const lines = csv.split(/\n/).filter((l) => l.length > 0);
  assert(lines.length === 2, `expected header + 1 data row, got ${lines.length}`);
  const headerCols = parseCsvLine(lines[0]);
  const rowCols = parseCsvLine(lines[1]);
  assert(headerCols.length === rowCols.length, `column count mismatch: header ${headerCols.length} vs row ${rowCols.length}`);
  assert(headerCols.length === 39, `expected 39 columns, got ${headerCols.length}`);

  const base = process.env.VERIFY_API_BASE_URL?.replace(/\/$/, '');
  const token = process.env.VERIFY_API_TOKEN;
  if (base && token) {
    const q = new URLSearchParams({
      limit: '1',
      page: '1',
      sortBy: 'createdAt:desc',
      format: 'csv',
    });
    const listRes = await fetch(`${base}/v1/candidates?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(listRes.ok, `list failed ${listRes.status}`);
    const listJson = await listRes.json();
    const total = listJson.totalResults ?? 0;

    const expRes = await fetch(`${base}/v1/candidates/export?${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (total > 10000) {
      assert(expRes.status === 400, `expected 400 when over cap, got ${expRes.status}`);
      console.log('API check: over-cap correctly rejected (total > 10000).');
    } else {
      assert(expRes.ok, `export failed ${expRes.status}`);
      const text = await expRes.text();
      const expLines = text.split(/\n/).filter((l) => l.length > 0);
      const dataRows = Math.max(0, expLines.length - 1);
      assert(dataRows === total, `export rows ${dataRows} !== list totalResults ${total}`);
      const hc = parseCsvLine(expLines[0]);
      for (let i = 1; i < expLines.length; i += 1) {
        const rc = parseCsvLine(expLines[i]);
        assert(rc.length === hc.length, `row ${i} column mismatch`);
      }
      console.log(`API check: export rows (${dataRows}) match list totalResults (${total}).`);
    }
  } else {
    console.log('Skip live API check (set VERIFY_API_BASE_URL + VERIFY_API_TOKEN to enable).');
  }

  console.log('verify-candidate-export-filters: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
