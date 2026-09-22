import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanRaw,
  classifyCardNumber,
  parseCardDate,
  buildEadFields,
} from '../services/eadExtract.service.js';

// --- cleanRaw -------------------------------------------------------------
test('cleanRaw: trims a real value', () => {
  assert.equal(cleanRaw('  SRC0000000701 '), 'SRC0000000701');
});
test('cleanRaw: model sentinels become null', () => {
  for (const s of ['', '   ', '-', '--', 'N/A', 'n/a', 'none', 'NULL', 'unknown', 'not visible']) {
    assert.equal(cleanRaw(s), null, `expected null for ${JSON.stringify(s)}`);
  }
});
test('cleanRaw: null and undefined become null', () => {
  assert.equal(cleanRaw(null), null);
  assert.equal(cleanRaw(undefined), null);
});

// --- classifyCardNumber ---------------------------------------------------
test('classifyCardNumber: specimen Card# is accepted and not flagged', () => {
  const r = classifyCardNumber('SRC0000000701');
  assert.equal(r.value, 'SRC0000000701');
  assert.equal(r.needsReview, false);
  assert.equal(r.warning, null);
});
test('classifyCardNumber: lowercase and spacing are normalised', () => {
  assert.equal(classifyCardNumber(' src 0000000701 ').value, 'SRC0000000701');
});
test('classifyCardNumber: dashed USCIS# is rejected, not stored', () => {
  const r = classifyCardNumber('000-000-701');
  assert.equal(r.value, null);
  assert.match(r.warning, /USCIS#/);
});
test('classifyCardNumber: bare nine-digit A-Number is rejected', () => {
  const r = classifyCardNumber('000000701');
  assert.equal(r.value, null);
  assert.match(r.warning, /USCIS#/);
});
test('classifyCardNumber: the FORM I-766 control number is kept but flagged', () => {
  const r = classifyCardNumber('99134258');
  assert.equal(r.value, '99134258');
  assert.equal(r.needsReview, true);
  assert.notEqual(r.warning, null);
});
test('classifyCardNumber: an unseen-but-plausible format is kept and flagged', () => {
  const r = classifyCardNumber('MSC1234567890123');
  assert.equal(r.value, 'MSC1234567890123');
  assert.equal(r.needsReview, true);
});
test('classifyCardNumber: nothing readable stays null and silent', () => {
  const r = classifyCardNumber(null);
  assert.equal(r.value, null);
  assert.equal(r.needsReview, false);
  assert.equal(r.warning, null);
});

// --- parseCardDate --------------------------------------------------------
test('parseCardDate: specimen dates parse as MM/DD/YY', () => {
  assert.equal(parseCardDate('03/07/18'), '2018-03-07');
  assert.equal(parseCardDate('03/06/20'), '2020-03-06');
});
test('parseCardDate: century window pivots at 79', () => {
  assert.equal(parseCardDate('01/01/79'), '2079-01-01');
  assert.equal(parseCardDate('01/01/80'), '1980-01-01');
});
test('parseCardDate: four-digit years are accepted verbatim', () => {
  assert.equal(parseCardDate('12/31/2027'), '2027-12-31');
});
test('parseCardDate: single-digit month and day are padded', () => {
  assert.equal(parseCardDate('3/7/18'), '2018-03-07');
});
test('parseCardDate: a day that does not exist is refused, never rolled over', () => {
  assert.equal(parseCardDate('02/31/26'), null);
});
test('parseCardDate: a month above 12 is refused rather than read as DD/MM', () => {
  assert.equal(parseCardDate('15/01/26'), null);
});
test('parseCardDate: the DOB format on the card is not a date here', () => {
  assert.equal(parseCardDate('01 JAN 1920'), null);
});
test('parseCardDate: junk and sentinels are null', () => {
  assert.equal(parseCardDate('N/A'), null);
  assert.equal(parseCardDate('see card'), null);
});

// --- buildEadFields -------------------------------------------------------
const specimen = {
  isEadCard: true,
  cardNumberRaw: 'SRC0000000701',
  validFromRaw: '03/07/18',
  expiresOnRaw: '03/06/20',
};

test('buildEadFields: the specimen card reads cleanly end to end', () => {
  const r = buildEadFields(specimen);
  assert.deepEqual(r.fields, {
    cardNumber: 'SRC0000000701',
    validFrom: '2018-03-07',
    validTo: '2020-03-06',
  });
  assert.deepEqual(r.needsReview, []);
  assert.deepEqual(r.warnings, []);
});
test('buildEadFields: an expired card is accepted, not an error', () => {
  // The specimen expired in 2020. Expired cards are exactly what HR needs recorded.
  const r = buildEadFields(specimen);
  assert.equal(r.fields.validTo, '2020-03-06');
  assert.deepEqual(r.warnings, []);
});
test('buildEadFields: isEadCard false returns nothing at all', () => {
  const r = buildEadFields({ ...specimen, isEadCard: false });
  assert.deepEqual(r.fields, { cardNumber: null, validFrom: null, validTo: null });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /does not look like an EAD card/);
});
test('buildEadFields: a USCIS# in the card slot is dropped, dates survive', () => {
  const r = buildEadFields({ ...specimen, cardNumberRaw: '000-000-701' });
  assert.equal(r.fields.cardNumber, null);
  assert.equal(r.fields.validFrom, '2018-03-07');
  assert.equal(r.warnings.length, 1);
});
test('buildEadFields: reversed dates discard BOTH and never swap', () => {
  const r = buildEadFields({ ...specimen, validFromRaw: '03/06/20', expiresOnRaw: '03/07/18' });
  assert.equal(r.fields.validFrom, null);
  assert.equal(r.fields.validTo, null);
  assert.equal(r.fields.cardNumber, 'SRC0000000701');
  assert.match(r.warnings.join(' '), /discarded/);
});
test('buildEadFields: equal dates are allowed', () => {
  const r = buildEadFields({ ...specimen, validFromRaw: '03/07/18', expiresOnRaw: '03/07/18' });
  assert.equal(r.fields.validFrom, '2018-03-07');
  assert.equal(r.fields.validTo, '2018-03-07');
});
test('buildEadFields: an unreadable date warns; the rest is still returned', () => {
  const r = buildEadFields({ ...specimen, expiresOnRaw: 'smudged' });
  assert.equal(r.fields.validTo, null);
  assert.equal(r.fields.validFrom, '2018-03-07');
  assert.match(r.warnings.join(' '), /Card Expires/);
});
test('buildEadFields: a date the model left null warns about nothing', () => {
  const r = buildEadFields({ ...specimen, expiresOnRaw: null });
  assert.equal(r.fields.validTo, null);
  assert.deepEqual(r.warnings, []);
});
test('buildEadFields: a flagged card number is named in needsReview', () => {
  const r = buildEadFields({ ...specimen, cardNumberRaw: '99134258' });
  assert.deepEqual(r.needsReview, ['cardNumber']);
});
test('buildEadFields: a missing payload does not throw', () => {
  const r = buildEadFields(undefined);
  assert.deepEqual(r.fields, { cardNumber: null, validFrom: null, validTo: null });
});
