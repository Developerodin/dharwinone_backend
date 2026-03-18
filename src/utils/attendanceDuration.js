/**
 * Shift-window overlap for attendance duration (shared by punch-out and live status preview).
 * @param {Date} refDate
 * @param {string} startTime "HH:mm"
 * @param {string} endTime "HH:mm"
 * @param {string} shiftTimezone IANA TZ
 */
export function getShiftWindowUtc(refDate, startTime, endTime, shiftTimezone) {
  const tz = shiftTimezone && shiftTimezone.trim() ? shiftTimezone.trim() : 'UTC';
  const [startH = 0, startM = 0] = (startTime || '00:00').toString().split(':').map(Number);
  const [endH = 0, endM = 0] = (endTime || '23:59').toString().split(':').map(Number);

  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = dateFmt.formatToParts(refDate);
  const getPart = (name) => parts.find((p) => p.type === name)?.value;
  const y = parseInt(getPart('year'), 10);
  const m = parseInt(getPart('month'), 10) - 1;
  const d = parseInt(getPart('day'), 10);

  const toUtcForLocalTime = (yy, mm, dd, hour, minute) => {
    let guess = new Date(Date.UTC(yy, mm, dd, hour, minute, 0, 0));
    for (let i = 0; i < 3; i++) {
      const fmt = new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false });
      const str = fmt.format(guess);
      const [gH, gM] = str.split(':').map(Number);
      const diffMs = ((gH - hour) * 60 + (gM - minute)) * 60 * 1000;
      guess = new Date(guess.getTime() - diffMs);
    }
    return guess;
  };

  const startUtc = toUtcForLocalTime(y, m, d, startH, startM);
  let endUtc = toUtcForLocalTime(y, m, d, endH, endM);
  if (endUtc.getTime() <= startUtc.getTime()) {
    const nextRef = new Date(Date.UTC(y, m, d + 1, 12, 0, 0));
    const nextParts = dateFmt.formatToParts(nextRef);
    const ny = parseInt(nextParts.find((p) => p.type === 'year')?.value, 10);
    const nm = parseInt(nextParts.find((p) => p.type === 'month')?.value, 10) - 1;
    const nd = parseInt(nextParts.find((p) => p.type === 'day')?.value, 10);
    endUtc = toUtcForLocalTime(ny, nm, nd, endH, endM);
  }
  return { startUtc, endUtc };
}

/**
 * @param {Date} punchIn
 * @param {Date} punchOut
 * @param {{ startTime: string, endTime: string, timezone: string } | null} shift
 * @returns {number} milliseconds
 */
export function computeDurationMs(punchIn, punchOut, shift) {
  const rawMs = punchOut.getTime() - punchIn.getTime();
  if (!shift || !shift.startTime || !shift.endTime || !shift.timezone) {
    return rawMs;
  }
  const { startUtc, endUtc } = getShiftWindowUtc(punchIn, shift.startTime, shift.endTime, shift.timezone);
  const overlapStart = Math.max(punchIn.getTime(), startUtc.getTime());
  const overlapEnd = Math.min(punchOut.getTime(), endUtc.getTime());
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  if (overlapMs === 0 && rawMs > 0) {
    return rawMs;
  }
  return overlapMs;
}
