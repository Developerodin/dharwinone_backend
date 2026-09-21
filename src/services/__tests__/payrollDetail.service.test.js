import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolvePayrollCountry, toMaskedView } from '../payrollDetail.service.js';
import { encryptField } from '../../utils/fieldCrypto.js';

// Set after the hoisted imports: nothing reads the key at module load, and this
// keeps the file free of top-level await (.eslintrc.json is ecmaVersion 2020).
process.env.PAYROLL_ENCRYPTION_KEY = '0'.repeat(64);

test('an already-saved country wins over every other signal', () => {
  const r = resolvePayrollCountry({
    existing: { payrollCountry: 'IN', countrySource: 'manual' },
    offer: { ctcBreakdown: { currency: 'USD' } },
    employee: { address: { country: 'United States' } },
  });
  assert.deepEqual(r, { country: 'IN', source: 'manual' });
});

test('offer currency beats the profile address', () => {
  const r = resolvePayrollCountry({
    existing: null,
    offer: { ctcBreakdown: { currency: 'INR' } },
    employee: { address: { country: 'United States' } },
  });
  assert.deepEqual(r, { country: 'IN', source: 'offerCurrency' });
});

test('falls back to the profile address when there is no offer', () => {
  const r = resolvePayrollCountry({
    existing: null,
    offer: null,
    employee: { address: { country: 'India' } },
  });
  assert.deepEqual(r, { country: 'IN', source: 'profileAddress' });
});

test('an unsupported currency falls through to the address rather than resolving wrongly', () => {
  const r = resolvePayrollCountry({
    existing: null,
    offer: { ctcBreakdown: { currency: 'GBP' } },
    employee: { address: { country: 'India' } },
  });
  assert.deepEqual(r, { country: 'IN', source: 'profileAddress' });
});

test('returns null when nothing resolves, so HR is asked rather than guessed at', () => {
  const r = resolvePayrollCountry({ existing: null, offer: null, employee: { address: {} } });
  assert.deepEqual(r, { country: null, source: null });
});

test('a blank address country does not resolve', () => {
  const r = resolvePayrollCountry({ existing: null, offer: null, employee: { address: { country: '   ' } } });
  assert.equal(r.country, null);
});

test('an employee with no address object at all does not throw', () => {
  const r = resolvePayrollCountry({ existing: null, offer: null, employee: {} });
  assert.equal(r.country, null);
});

test('masked view exposes only the last four digits', () => {
  const view = toMaskedView({
    id: 'x',
    payrollCountry: 'IN',
    countrySource: 'manual',
    status: 'submitted',
    bank: {
      accountHolderName: 'A Person',
      bankName: 'HDFC',
      accountType: 'savings',
      ifsc: 'HDFC0001234',
      accountNumberEnc: encryptField('123456789012'),
      accountNumberLast4: '9012',
    },
  });
  assert.equal(view.bank.accountNumberLast4, '9012');
  assert.equal(view.bank.accountNumberMasked, '\u2022\u2022\u2022\u20229012');
  assert.equal(view.bank.accountNumberEnc, undefined, 'ciphertext must never reach a client');
  assert.equal(view.bank.accountNumber, undefined, 'plaintext must never reach a list response');
});

test('masked view of a record with no bank data yet does not throw', () => {
  const view = toMaskedView({ id: 'x', payrollCountry: 'US', countrySource: 'manual', status: 'requested' });
  assert.equal(view.status, 'requested');
  assert.equal(view.bank.accountNumberMasked, '');
});

test('masked view of a null document is null', () => {
  assert.equal(toMaskedView(null), null);
});

test('clearBankProofIndex is exported so the document-delete cascade can call it', async () => {
  const mod = await import('../payrollDetail.service.js');
  assert.equal(typeof mod.clearBankProofIndex, 'function');
});

test('the ats audit helper signals failure by returning a falsy entry, not by throwing', async () => {
  // Guard for payrollDetail.controller revealAccount: persistActivityLogFailSoft is
  // fail-soft, so a failed audit write resolves with null. The controller MUST check
  // the return value — awaiting it is not enough.
  const src = await readFile(new URL('../atsAudit.service.js', import.meta.url), 'utf8');
  assert.match(src, /return entry;/, 'persistAtsAudit still returns the entry (null on failure)');
});

test('masked view never exposes SSN ciphertext or plaintext', () => {
  const view = toMaskedView({
    id: 'x',
    payrollCountry: 'US',
    countrySource: 'manual',
    status: 'submitted',
    tax: { ssnEnc: encryptField('123456789'), ssnLast4: '6789', ssnStatus: 'provided' },
  });
  assert.equal(view.tax.ssnMasked, '\u2022\u2022\u2022-\u2022\u2022-6789');
  assert.equal(view.tax.ssnEnc, undefined);
  assert.equal(view.tax.ssn, undefined);
});

test('masked view never exposes PAN ciphertext or plaintext', () => {
  const view = toMaskedView({
    id: 'x',
    payrollCountry: 'IN',
    countrySource: 'manual',
    status: 'submitted',
    tax: { panEnc: encryptField('ABCDE1234F'), panLast4: '234F' },
  });
  assert.equal(view.tax.panMasked, '\u2022\u2022\u2022\u2022\u2022\u2022234F');
  assert.equal(view.tax.panEnc, undefined);
  assert.equal(view.tax.pan, undefined);
});

test('masked view handles a record with no tax block', () => {
  const view = toMaskedView({ id: 'x', payrollCountry: 'IN', countrySource: 'manual', status: 'requested' });
  assert.equal(view.tax.ssnMasked, '');
  assert.equal(view.tax.panMasked, '');
});

test('ESI applies at or below the gross ceiling', async () => {
  const { deriveIndiaStatutory } = await import('../payrollDetail.service.js');
  assert.equal(deriveIndiaStatutory(21000).esiApplicable, true);
  assert.equal(deriveIndiaStatutory(20999).esiApplicable, true);
  assert.equal(deriveIndiaStatutory(21001).esiApplicable, false);
});

test('PF applies regardless of the ceiling — the ceiling caps the contribution, not eligibility', async () => {
  const { deriveIndiaStatutory } = await import('../payrollDetail.service.js');
  assert.equal(deriveIndiaStatutory(50000).pfApplicable, true);
  assert.equal(deriveIndiaStatutory(10000).pfApplicable, true);
});

test('records the gross that produced the assessment', async () => {
  const { deriveIndiaStatutory } = await import('../payrollDetail.service.js');
  const r = deriveIndiaStatutory(18000);
  assert.equal(r.monthlyGrossAtAssessment, 18000);
  assert.ok(r.applicabilityAssessedAt instanceof Date);
});

test('an unknown gross leaves applicability undecided rather than guessing', async () => {
  const { deriveIndiaStatutory } = await import('../payrollDetail.service.js');
  const r = deriveIndiaStatutory(null);
  assert.equal(r.pfApplicable, undefined);
  assert.equal(r.esiApplicable, undefined);
});

test('cancelPayrollRequest is exported for the request-withdrawal route', async () => {
  const mod = await import('../payrollDetail.service.js');
  assert.equal(typeof mod.cancelPayrollRequest, 'function');
});

test('cancel is wired to the same gate as request, and only on DELETE', async () => {
  // Guard: cancel must not quietly end up on the broader read gate, and must not
  // become a GET — it deletes a record.
  const route = await readFile(new URL('../../routes/v1/payrollDetail.route.js', import.meta.url), 'utf8');
  assert.match(route, /\.delete\(\.\.\.canRequest,[\s\S]*?payrollController\.cancelRequest\)/);
});

test('cancel refuses any status other than requested', async () => {
  // The service must never delete a record that already carries submitted bank
  // details. Pin the guard by source so a refactor cannot silently widen it.
  const src = await readFile(new URL('../payrollDetail.service.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export const cancelPayrollRequest'));
  assert.match(fn, /doc\.status !== 'requested'/);
  assert.match(fn, /BAD_REQUEST/);
});
