import test from 'node:test';
import assert from 'node:assert/strict';
import { submitDetails, requestDetails, verifyDetails } from '../payrollDetail.validation.js';

const ok = (schema, value) => {
  const { error } = schema.validate(value);
  return { valid: !error, message: error?.message };
};

const US_BODY = {
  bank: {
    accountHolderName: 'Jane Doe',
    bankName: 'Example Bank',
    accountType: 'checking',
    routingNumber: '021000021',
    accountNumber: '12345678901',
  },
};

const IN_BODY = {
  bank: {
    accountHolderName: 'Rahul Kumar',
    bankName: 'Example Bank',
    accountType: 'savings',
    ifsc: 'HDFC0001234',
    branchName: 'Koramangala',
    accountNumber: '123456789012',
  },
};

test('accepts a complete US submission', () => {
  const r = ok(submitDetails.body, { payrollCountry: 'US', ...US_BODY });
  assert.equal(r.valid, true, r.message);
});

test('accepts a complete India submission', () => {
  const r = ok(submitDetails.body, { payrollCountry: 'IN', ...IN_BODY });
  assert.equal(r.valid, true, r.message);
});

test('rejects a US submission missing the routing number', () => {
  const bank = { ...US_BODY.bank };
  delete bank.routingNumber;
  assert.equal(ok(submitDetails.body, { payrollCountry: 'US', bank }).valid, false);
});

test('rejects a US routing number that is not nine digits', () => {
  const bank = { ...US_BODY.bank, routingNumber: '12345678' };
  assert.equal(ok(submitDetails.body, { payrollCountry: 'US', bank }).valid, false);
});

test('rejects an India submission missing the IFSC', () => {
  const bank = { ...IN_BODY.bank };
  delete bank.ifsc;
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', bank }).valid, false);
});

test('rejects a malformed IFSC', () => {
  const bank = { ...IN_BODY.bank, ifsc: 'HDFC1001234' };
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', bank }).valid, false);
});

test('rejects an IFSC sent on a US submission — wrong country field', () => {
  const bank = { ...US_BODY.bank, ifsc: 'HDFC0001234' };
  assert.equal(ok(submitDetails.body, { payrollCountry: 'US', bank }).valid, false);
});

test('rejects a routing number sent on an India submission', () => {
  const bank = { ...IN_BODY.bank, routingNumber: '021000021' };
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', bank }).valid, false);
});

test('rejects "current" as a US account type and accepts it for India', () => {
  assert.equal(ok(submitDetails.body, { payrollCountry: 'US', bank: { ...US_BODY.bank, accountType: 'current' } }).valid, false);
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', bank: { ...IN_BODY.bank, accountType: 'current' } }).valid, true);
});

test('rejects an unknown key outright — validate() runs without allowUnknown', () => {
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', ...IN_BODY, nickname: 'my account' }).valid, false);
});

test('rejects a confirm-account field — the form must strip it before sending', () => {
  const bank = { ...IN_BODY.bank, confirmAccountNumber: '123456789012' };
  assert.equal(ok(submitDetails.body, { payrollCountry: 'IN', bank }).valid, false);
});

test('request accepts an optional country and notes', () => {
  assert.equal(ok(requestDetails.body, {}).valid, true);
  assert.equal(ok(requestDetails.body, { payrollCountry: 'IN', requestNotes: 'Before Friday' }).valid, true);
  assert.equal(ok(requestDetails.body, { payrollCountry: 'GB' }).valid, false);
});

test('verify requires a reason when rejecting and forbids one when approving', () => {
  assert.equal(ok(verifyDetails.body, { approved: true }).valid, true);
  assert.equal(ok(verifyDetails.body, { approved: false }).valid, false);
  assert.equal(ok(verifyDetails.body, { approved: false, rejectionReason: 'Name mismatch' }).valid, true);
  assert.equal(ok(verifyDetails.body, { approved: true, rejectionReason: 'stale' }).valid, false);
});

test('accepts a US tax block with a provided SSN', () => {
  const body = {
    payrollCountry: 'US',
    ...US_BODY,
    tax: {
      ssn: '123456789',
      ssnStatus: 'provided',
      filingStatus: 'single_or_married_separately',
      multipleJobs: false,
      dependentsAmount: 2000,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 50,
      workState: 'TX',
    },
  };
  const r = ok(submitDetails.body, body);
  assert.equal(r.valid, true, r.message);
});

test('accepts a US tax block with a pending SSN and no number', () => {
  const body = {
    payrollCountry: 'US',
    ...US_BODY,
    tax: { ssnStatus: 'pending', filingStatus: 'head_of_household', workState: 'CA' },
  };
  const r = ok(submitDetails.body, body);
  assert.equal(r.valid, true, r.message);
});

test('rejects ssnStatus "provided" with no ssn', () => {
  const body = {
    payrollCountry: 'US',
    ...US_BODY,
    tax: { ssnStatus: 'provided', filingStatus: 'head_of_household' },
  };
  assert.equal(ok(submitDetails.body, body).valid, false);
});

test('accepts an SSN written with dashes', () => {
  const body = {
    payrollCountry: 'US',
    ...US_BODY,
    tax: { ssn: '123-45-6789', ssnStatus: 'provided', filingStatus: 'head_of_household' },
  };
  const r = ok(submitDetails.body, body);
  assert.equal(r.valid, true, r.message);
});

test('accepts an India tax block', () => {
  const body = {
    payrollCountry: 'IN',
    ...IN_BODY,
    tax: { pan: 'ABCDE1234F', taxRegime: 'new', form12bPreviousIncome: 400000, form12bPreviousTds: 12000 },
  };
  const r = ok(submitDetails.body, body);
  assert.equal(r.valid, true, r.message);
});

test('rejects a malformed PAN', () => {
  const body = { payrollCountry: 'IN', ...IN_BODY, tax: { pan: 'ABCD11234F', taxRegime: 'new' } };
  assert.equal(ok(submitDetails.body, body).valid, false);
});

test('rejects a PAN sent on a US submission', () => {
  const body = { payrollCountry: 'US', ...US_BODY, tax: { pan: 'ABCDE1234F', ssnStatus: 'pending', filingStatus: 'head_of_household' } };
  assert.equal(ok(submitDetails.body, body).valid, false);
});

test('rejects a W-4 filing status sent on an India submission', () => {
  const body = { payrollCountry: 'IN', ...IN_BODY, tax: { pan: 'ABCDE1234F', taxRegime: 'new', filingStatus: 'head_of_household' } };
  assert.equal(ok(submitDetails.body, body).valid, false);
});

test('the tax block as a whole stays optional — bank-only submissions still pass', () => {
  assert.equal(ok(submitDetails.body, { payrollCountry: 'US', ...US_BODY }).valid, true);
});

test('accepts an India statutory block with UAN and no Aadhaar', () => {
  const body = { payrollCountry: 'IN', ...IN_BODY, statutory: { uan: '100123456789', hasExistingUan: true } };
  const r = ok(submitDetails.body, body);
  assert.equal(r.valid, true, r.message);
});

test('rejects a client-asserted ESI applicability', () => {
  const body = { payrollCountry: 'IN', ...IN_BODY, statutory: { esiApplicable: true } };
  assert.equal(ok(submitDetails.body, body).valid, false);
});

test('rejects a malformed Aadhaar', () => {
  const body = { payrollCountry: 'IN', ...IN_BODY, statutory: { aadhaar: '134567890123' } };
  assert.equal(ok(submitDetails.body, body).valid, false);
});
