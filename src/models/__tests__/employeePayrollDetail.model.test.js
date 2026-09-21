import test from 'node:test';
import assert from 'node:assert/strict';
import EmployeePayrollDetail from '../employeePayrollDetail.model.js';

const path = (p) => EmployeePayrollDetail.schema.path(p);

test('links to exactly one Employee, uniquely', () => {
  const p = path('employee');
  assert.equal(p.instance, 'ObjectId');
  assert.equal(p.options.ref, 'Employee');
  assert.equal(p.options.unique, true);
});

test('payrollCountry is constrained to the supported countries', () => {
  assert.deepEqual(path('payrollCountry').options.enum, ['US', 'IN']);
});

test('records how the country was chosen so a wrong default is traceable', () => {
  assert.deepEqual(path('countrySource').options.enum, ['offerCurrency', 'profileAddress', 'manual']);
});

test('status covers the full request lifecycle', () => {
  assert.deepEqual(path('status').options.enum, ['requested', 'submitted', 'verified', 'rejected']);
});

test('stores the account number encrypted with a plaintext last-4 mirror', () => {
  assert.equal(path('bank.accountNumberEnc').instance, 'String');
  assert.equal(path('bank.accountNumberLast4').instance, 'String');
});

test('does not declare a plaintext account number path', () => {
  assert.equal(path('bank.accountNumber'), undefined);
});

test('keeps routing number and IFSC in plaintext — both are public branch identifiers', () => {
  assert.equal(path('bank.routingNumber').instance, 'String');
  assert.equal(path('bank.ifsc').instance, 'String');
});

test('accountType is constrained', () => {
  assert.deepEqual(path('bank.accountType').options.enum, ['checking', 'savings', 'current']);
});

test('points at the bank proof by its index in Employee.documents', () => {
  assert.equal(path('bankProofDocumentIndex').instance, 'Number');
});

test('stamps who requested, submitted, verified and when', () => {
  for (const p of ['requestedBy', 'submittedBy', 'verifiedBy']) {
    assert.equal(path(p).instance, 'ObjectId', `${p} should be an ObjectId`);
  }
  for (const p of ['requestedAt', 'submittedAt', 'verifiedAt']) {
    assert.equal(path(p).instance, 'Date', `${p} should be a Date`);
  }
});

test('declares an index on employee for the one lookup that exists', () => {
  const hasIdx = EmployeePayrollDetail.schema.indexes().some(([def]) => def.employee === 1);
  assert.equal(hasIdx, true);
});

test('stores US tax fields with the SSN encrypted and a last-4 mirror', () => {
  assert.equal(path('tax.ssnEnc').instance, 'String');
  assert.equal(path('tax.ssnLast4').instance, 'String');
  assert.equal(path('tax.ssn'), undefined, 'no plaintext SSN path');
});

test('records that an SSN is pending rather than forcing a fake one', () => {
  assert.deepEqual(path('tax.ssnStatus').options.enum, ['provided', 'pending', 'itin']);
});

test('stores W-4 filing status using the current form wording', () => {
  assert.deepEqual(path('tax.filingStatus').options.enum, [
    'single_or_married_separately',
    'married_jointly_or_surviving_spouse',
    'head_of_household',
  ]);
});

test('stores the remaining W-4 step values', () => {
  for (const p of [
    'tax.multipleJobs',
    'tax.dependentsAmount',
    'tax.otherIncome',
    'tax.deductions',
    'tax.extraWithholding',
  ]) {
    assert.ok(path(p), `${p} should exist`);
  }
});

test('stores the work state for state withholding without modelling 41 state forms', () => {
  assert.equal(path('tax.workState').instance, 'String');
  assert.equal(path('tax.stateWithholdingDocumentIndex').instance, 'Number');
});

test('stores India tax fields with PAN encrypted', () => {
  assert.equal(path('tax.panEnc').instance, 'String');
  assert.equal(path('tax.panLast4').instance, 'String');
  assert.deepEqual(path('tax.taxRegime').options.enum, ['new', 'old']);
});

test('stores previous-employer income under the Form 12B name', () => {
  assert.equal(path('tax.form12bPreviousIncome').instance, 'Number');
  assert.equal(path('tax.form12bPreviousTds').instance, 'Number');
});

test('stores India statutory identifiers encrypted', () => {
  assert.equal(path('statutory.aadhaarEnc').instance, 'String');
  assert.equal(path('statutory.aadhaarLast4').instance, 'String');
  assert.equal(path('statutory.uanEnc').instance, 'String');
  assert.equal(path('statutory.uanLast4').instance, 'String');
});

test('records whether the person has an existing UAN', () => {
  assert.equal(path('statutory.hasExistingUan').instance, 'Boolean');
});

test('PF and ESI applicability are stored with the input that produced them', () => {
  assert.equal(path('statutory.pfApplicable').instance, 'Boolean');
  assert.equal(path('statutory.esiApplicable').instance, 'Boolean');
  assert.equal(path('statutory.monthlyGrossAtAssessment').instance, 'Number');
  assert.equal(path('statutory.applicabilityAssessedAt').instance, 'Date');
});

test('nominations are document pointers', () => {
  for (const p of [
    'statutory.epfNominationDocumentIndex',
    'statutory.gratuityNominationDocumentIndex',
    'statutory.esicFamilyDocumentIndex',
  ]) {
    assert.equal(path(p).instance, 'Number', `${p} should be a Number`);
  }
});

test('stores the US I-9 completion pointer', () => {
  assert.equal(path('statutory.i9DocumentIndex').instance, 'Number');
  assert.equal(path('statutory.i9CompletedAt').instance, 'Date');
});
