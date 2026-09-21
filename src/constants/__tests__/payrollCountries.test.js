import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_COUNTRIES,
  CURRENCY_TO_COUNTRY,
  COUNTRY_NAME_TO_CODE,
  PATTERNS,
} from '../payrollCountries.js';

test('exposes exactly the two supported countries', () => {
  assert.deepEqual([...PAYROLL_COUNTRIES], ['US', 'IN']);
});

test('maps offer currency to a payroll country', () => {
  assert.equal(CURRENCY_TO_COUNTRY.USD, 'US');
  assert.equal(CURRENCY_TO_COUNTRY.INR, 'IN');
  assert.equal(CURRENCY_TO_COUNTRY.GBP, undefined);
});

test('maps the CountrySelect display names used by the profile form', () => {
  assert.equal(COUNTRY_NAME_TO_CODE['United States'], 'US');
  assert.equal(COUNTRY_NAME_TO_CODE.India, 'IN');
});

test('IFSC requires 4 alpha, a zero, then 6 alphanumeric', () => {
  assert.equal(PATTERNS.IFSC.test('HDFC0001234'), true);
  assert.equal(PATTERNS.IFSC.test('HDFC1001234'), false, 'fifth character must be 0');
  assert.equal(PATTERNS.IFSC.test('HDFC000123'), false, 'must be 11 characters');
});

test('PAN requires 5 alpha, 4 digits, 1 alpha', () => {
  assert.equal(PATTERNS.PAN.test('ABCDE1234F'), true);
  assert.equal(PATTERNS.PAN.test('ABCD11234F'), false);
  assert.equal(PATTERNS.PAN.test('ABCDE1234'), false);
});

test('ABA routing is exactly nine digits', () => {
  assert.equal(PATTERNS.ABA_ROUTING.test('021000021'), true);
  assert.equal(PATTERNS.ABA_ROUTING.test('02100002'), false);
  assert.equal(PATTERNS.ABA_ROUTING.test('0210000211'), false);
});

test('US account number allows up to seventeen digits', () => {
  assert.equal(PATTERNS.ACCOUNT_US.test('1'), true);
  assert.equal(PATTERNS.ACCOUNT_US.test('12345678901234567'), true);
  assert.equal(PATTERNS.ACCOUNT_US.test('123456789012345678'), false);
  assert.equal(PATTERNS.ACCOUNT_US.test('12345A'), false);
});

test('Indian account number allows nine to eighteen digits', () => {
  assert.equal(PATTERNS.ACCOUNT_IN.test('123456789'), true);
  assert.equal(PATTERNS.ACCOUNT_IN.test('123456789012345678'), true);
  assert.equal(PATTERNS.ACCOUNT_IN.test('12345678'), false);
});

test('Aadhaar is twelve digits not starting 0 or 1', () => {
  assert.equal(PATTERNS.AADHAAR.test('234567890123'), true);
  assert.equal(PATTERNS.AADHAAR.test('134567890123'), false);
  assert.equal(PATTERNS.AADHAAR.test('23456789012'), false);
});

test('UAN is twelve digits', () => {
  assert.equal(PATTERNS.UAN.test('100123456789'), true);
  assert.equal(PATTERNS.UAN.test('10012345678'), false);
});

test('SSN is nine digits after dashes are stripped', () => {
  assert.equal(PATTERNS.SSN.test('123456789'), true);
  assert.equal(PATTERNS.SSN.test('12345678'), false);
});

test('exposes the statutory thresholds as named constants', async () => {
  const { INDIA_THRESHOLDS } = await import('../payrollCountries.js');
  assert.equal(INDIA_THRESHOLDS.ESI_MONTHLY_GROSS_CEILING, 21000);
  assert.equal(INDIA_THRESHOLDS.EPF_MONTHLY_WAGE_CEILING, 15000);
});
