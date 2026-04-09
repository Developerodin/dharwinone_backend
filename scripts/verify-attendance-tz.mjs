/**
 * Verification script for attendance timezone fix.
 * Tests getLocalMidnightAndDay helper against known inputs/outputs.
 *
 * Usage: node scripts/verify-attendance-tz.mjs
 */
import assert from 'assert';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getLocalMidnightAndDay(instant, timezone) {
  const tz = timezone && timezone.trim() ? timezone.trim() : 'UTC';
  const d = new Date(instant);
  if (tz === 'UTC') {
    return {
      midnight: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())),
      day: DAY_NAMES[d.getUTCDay()],
    };
  }
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dateFmt.formatToParts(d);
  const getPart = (name) => parts.find((p) => p.type === name)?.value;
  const y = parseInt(getPart('year'), 10);
  const m = parseInt(getPart('month'), 10) - 1;
  const dd = parseInt(getPart('day'), 10);

  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
  const day = weekdayFmt.format(d);

  const midnight = new Date(Date.UTC(y, m, dd));
  return { midnight, day };
}

function getLocalDateKey(isoDateStr) {
  const d = new Date(isoDateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('=== Test 1: Day-date alignment (IST) ===');
test('Monday 08:51 IST → Mon Mar 30', () => {
  // Mon 2026-03-30 08:51 IST = Mon 2026-03-30 03:21 UTC
  const punchIn = new Date('2026-03-30T03:21:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

test('Sunday 23:59 IST → Sun Mar 29', () => {
  // Sun 2026-03-29 23:59 IST = Sun 2026-03-29 18:29 UTC
  const punchIn = new Date('2026-03-29T18:29:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Sunday');
  assert.strictEqual(midnight.toISOString(), '2026-03-29T00:00:00.000Z');
});

test('Friday 09:00 IST → Fri Mar 27', () => {
  // Fri 2026-03-27 09:00 IST = Fri 2026-03-27 03:30 UTC
  const punchIn = new Date('2026-03-27T03:30:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Friday');
  assert.strictEqual(midnight.toISOString(), '2026-03-27T00:00:00.000Z');
});

console.log('\n=== Test 2: Weekend correctness ===');
test('Saturday 10:00 IST → Saturday', () => {
  // Sat 2026-03-28 10:00 IST = Sat 2026-03-28 04:30 UTC
  const punchIn = new Date('2026-03-28T04:30:00Z');
  const { day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Saturday');
});

test('Friday midnight-crossing IST (Sat 00:30 IST) → Saturday', () => {
  // Sat 2026-03-28 00:30 IST = Fri 2026-03-27 19:00 UTC
  const punchIn = new Date('2026-03-27T19:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Saturday');
  assert.strictEqual(midnight.toISOString(), '2026-03-28T00:00:00.000Z');
});

console.log('\n=== Test 3: Negative offset timezone (US Eastern) ===');
test('Monday 20:00 UTC → Monday in EST (15:00 local)', () => {
  const punchIn = new Date('2026-03-30T20:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'America/New_York');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

test('Tuesday 03:00 UTC → Monday in EST (22:00 local)', () => {
  // Tue 2026-03-31 03:00 UTC = Mon 2026-03-30 23:00 EDT (DST active)
  const punchIn = new Date('2026-03-31T03:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'America/New_York');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

console.log('\n=== Test 4: UTC fallback ===');
test('UTC timezone works same as old getUtcMidnight', () => {
  const punchIn = new Date('2026-03-30T15:30:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'UTC');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

test('Empty/null timezone defaults to UTC', () => {
  const punchIn = new Date('2026-03-30T15:30:00Z');
  const r1 = getLocalMidnightAndDay(punchIn, '');
  const r2 = getLocalMidnightAndDay(punchIn, null);
  assert.strictEqual(r1.day, 'Monday');
  assert.strictEqual(r2.day, 'Monday');
});

console.log('\n=== Test 5: Midnight edge cases ===');
test('Exactly midnight IST (18:30 UTC previous day) → correct date', () => {
  // Mon 2026-03-30 00:00:00 IST = Sun 2026-03-29 18:30:00 UTC
  const punchIn = new Date('2026-03-29T18:30:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

test('Just before midnight IST (18:29:59 UTC) → previous date', () => {
  // Sun 2026-03-29 23:59:59 IST = Sun 2026-03-29 18:29:59 UTC
  const punchIn = new Date('2026-03-29T18:29:59Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Asia/Kolkata');
  assert.strictEqual(day, 'Sunday');
  assert.strictEqual(midnight.toISOString(), '2026-03-29T00:00:00.000Z');
});

console.log('\n=== Test 6: getLocalDateKey (frontend) ===');
test('UTC midnight date extracts correct YYYY-MM-DD', () => {
  assert.strictEqual(getLocalDateKey('2026-03-30T00:00:00.000Z'), '2026-03-30');
  assert.strictEqual(getLocalDateKey('2026-01-01T00:00:00.000Z'), '2026-01-01');
  assert.strictEqual(getLocalDateKey('2026-12-31T00:00:00.000Z'), '2026-12-31');
});

test('formatDate with timeZone UTC gives correct display regardless of runtime TZ', () => {
  const d = new Date('2026-03-30T00:00:00.000Z');
  const formatted = d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  assert.ok(formatted.includes('Mon'), `Expected 'Mon' in "${formatted}"`);
  assert.ok(formatted.includes('30'), `Expected '30' in "${formatted}"`);
  assert.ok(formatted.includes('2026'), `Expected '2026' in "${formatted}"`);
});

console.log('\n=== Test 7: Duration independence ===');
test('Duration is punchOut - punchIn regardless of timezone', () => {
  const punchIn = new Date('2026-03-29T03:21:00Z');
  const punchOut = new Date('2026-03-29T12:00:00Z');
  const durationMs = punchOut.getTime() - punchIn.getTime();
  const expectedHours = 8 + 39 / 60;
  const actualHours = durationMs / (1000 * 60 * 60);
  assert.ok(Math.abs(actualHours - expectedHours) < 0.01, `Duration ${actualHours}h ≈ ${expectedHours}h`);
});

console.log('\n=== Test 8: Extreme timezones ===');
test('UTC+14 (Pacific/Kiritimati) → date can be ahead of UTC', () => {
  // Mon 2026-03-30 01:00 UTC = Tue 2026-03-31 01:00 UTC+14 (actually +14)
  // Wait, Kiritimati is UTC+14.
  // Mon 2026-03-30 01:00 UTC = Mon 2026-03-30 15:00 UTC+14
  const punchIn = new Date('2026-03-30T01:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Pacific/Kiritimati');
  assert.strictEqual(day, 'Monday');
  assert.strictEqual(midnight.toISOString(), '2026-03-30T00:00:00.000Z');
});

test('UTC+14 near midnight → next day', () => {
  // Mon 2026-03-30 10:00 UTC = Tue 2026-03-31 00:00 UTC+14
  const punchIn = new Date('2026-03-30T10:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Pacific/Kiritimati');
  assert.strictEqual(day, 'Tuesday');
  assert.strictEqual(midnight.toISOString(), '2026-03-31T00:00:00.000Z');
});

test('UTC-12 (Etc/GMT+12) → date can be behind UTC', () => {
  // Mon 2026-03-30 11:00 UTC = Sun 2026-03-29 23:00 UTC-12
  const punchIn = new Date('2026-03-30T11:00:00Z');
  const { midnight, day } = getLocalMidnightAndDay(punchIn, 'Etc/GMT+12');
  assert.strictEqual(day, 'Sunday');
  assert.strictEqual(midnight.toISOString(), '2026-03-29T00:00:00.000Z');
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed!');
