import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVisaNumber,
  parseVisaDate,
  buildVisaFields,
} from '../services/visaExtract.service.js';

// --- classifyVisaNumber ---------------------------------------------------
test('classifyVisaNumber: specimen visa number is accepted and not flagged', () => {
  const r = classifyVisaNumber('00000001');
  assert.equal(r.value, '00000001');
  assert.equal(r.needsReview, false);
  assert.equal(r.warning, null);
});

test('classifyVisaNumber: the passport number is rejected, not stored', () => {
  // Passport No. sits one row under Given Names on the same specimen, so it is the
  // value a careless read returns instead of the visa number.
  const r = classifyVisaNumber('P00000001');
  assert.equal(r.value, null);
  assert.match(r.warning, /passport/i);
});

test('classifyVisaNumber: the control number is rejected, not stored', () => {
  const r = classifyVisaNumber('00000000000001');
  assert.equal(r.value, null);
  assert.match(r.warning, /control/i);
});

test('classifyVisaNumber: spacing is stripped', () => {
  assert.equal(classifyVisaNumber(' 0000 0001 ').value, '00000001');
});

test('classifyVisaNumber: an unusual length is kept but flagged', () => {
  const r = classifyVisaNumber('1234567');
  assert.equal(r.value, '1234567');
  assert.equal(r.needsReview, true);
  assert.notEqual(r.warning, null);
});

test('classifyVisaNumber: nothing readable stays null and silent', () => {
  const r = classifyVisaNumber(null);
  assert.equal(r.value, null);
  assert.equal(r.needsReview, false);
  assert.equal(r.warning, null);
});

test('classifyVisaNumber: sentinels become null', () => {
  assert.equal(classifyVisaNumber('N/A').value, null);
});

// --- parseVisaDate --------------------------------------------------------
test('parseVisaDate: specimen dates parse as DD MMM YYYY', () => {
  assert.equal(parseVisaDate('01 FEB 2026'), '2026-02-01');
  assert.equal(parseVisaDate('31 JAN 2036'), '2036-01-31');
});

test('parseVisaDate: mixed case and extra spacing are tolerated', () => {
  assert.equal(parseVisaDate('  01  Feb  2026 '), '2026-02-01');
});

test('parseVisaDate: hyphenated form is accepted', () => {
  assert.equal(parseVisaDate('01-FEB-2026'), '2026-02-01');
});

test('parseVisaDate: every month abbreviation resolves', () => {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  months.forEach((mon, i) => {
    assert.equal(parseVisaDate(`01 ${mon} 2026`), `2026-${String(i + 1).padStart(2, '0')}-01`);
  });
});

test('parseVisaDate: a day that does not exist is refused, never rolled over', () => {
  assert.equal(parseVisaDate('31 FEB 2026'), null);
});

test('parseVisaDate: a nonsense month is refused', () => {
  assert.equal(parseVisaDate('01 XYZ 2026'), null);
});

test('parseVisaDate: the EAD slash format is not a visa date', () => {
  // The visa prints DD MMM YYYY only; accepting MM/DD/YY here would let an EAD
  // date through a visa scan unnoticed.
  assert.equal(parseVisaDate('03/07/18'), null);
});

test('parseVisaDate: junk and sentinels are null', () => {
  assert.equal(parseVisaDate('see visa'), null);
  assert.equal(parseVisaDate('N/A'), null);
});

// --- buildVisaFields ------------------------------------------------------
const specimen = {
  isVisa: true,
  visaNumberRaw: '00000001',
  issueDateRaw: '01 FEB 2026',
  expiryDateRaw: '31 JAN 2036',
};

test('buildVisaFields: the specimen visa reads cleanly end to end', () => {
  const r = buildVisaFields(specimen);
  assert.deepEqual(r.fields, {
    visaNumber: '00000001',
    issueDate: '2026-02-01',
    expiryDate: '2036-01-31',
  });
  assert.deepEqual(r.needsReview, []);
  assert.deepEqual(r.warnings, []);
});

test('buildVisaFields: isVisa false returns nothing at all', () => {
  const r = buildVisaFields({ ...specimen, isVisa: false });
  assert.deepEqual(r.fields, { visaNumber: null, issueDate: null, expiryDate: null });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /does not look like a visa/i);
});

test('buildVisaFields: a passport number in the visa slot is dropped, dates survive', () => {
  const r = buildVisaFields({ ...specimen, visaNumberRaw: 'P00000001' });
  assert.equal(r.fields.visaNumber, null);
  assert.equal(r.fields.issueDate, '2026-02-01');
  assert.equal(r.warnings.length, 1);
});

test('buildVisaFields: reversed dates discard BOTH and never swap', () => {
  const r = buildVisaFields({ ...specimen, issueDateRaw: '31 JAN 2036', expiryDateRaw: '01 FEB 2026' });
  assert.equal(r.fields.issueDate, null);
  assert.equal(r.fields.expiryDate, null);
  assert.equal(r.fields.visaNumber, '00000001');
  assert.match(r.warnings.join(' '), /discarded/);
});

test('buildVisaFields: an expired visa is accepted, not an error', () => {
  const r = buildVisaFields({ ...specimen, issueDateRaw: '01 FEB 2016', expiryDateRaw: '31 JAN 2020' });
  assert.equal(r.fields.expiryDate, '2020-01-31');
  assert.deepEqual(r.warnings, []);
});

test('buildVisaFields: a date the model left null warns about nothing', () => {
  // DOB shares the DD MMM YYYY format with both target dates on this document, so
  // only label anchoring separates them. If the model returns nothing for the issue
  // date, nothing is what gets stored.
  const r = buildVisaFields({ ...specimen, issueDateRaw: null });
  assert.equal(r.fields.issueDate, null);
  assert.deepEqual(r.warnings, []);
});

test('buildVisaFields: an unreadable date warns; the rest is still returned', () => {
  const r = buildVisaFields({ ...specimen, expiryDateRaw: 'smudged' });
  assert.equal(r.fields.expiryDate, null);
  assert.equal(r.fields.issueDate, '2026-02-01');
  assert.match(r.warnings.join(' '), /Expiration Date/i);
});

test('buildVisaFields: a flagged visa number is named in needsReview', () => {
  const r = buildVisaFields({ ...specimen, visaNumberRaw: '1234567' });
  assert.deepEqual(r.needsReview, ['visaNumber']);
});

test('buildVisaFields: a missing payload does not throw', () => {
  const r = buildVisaFields(undefined);
  assert.deepEqual(r.fields, { visaNumber: null, issueDate: null, expiryDate: null });
});
