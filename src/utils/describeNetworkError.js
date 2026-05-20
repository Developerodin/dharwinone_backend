/**
 * Flatten Node/System/AggregateError fields for ops logs (ECONNREFUSED, DNS, etc.).
 * Safe on arbitrary thrown values.
 * @param {unknown} err
 * @param {number} [depth]
 * @returns {string}
 */
export function describeNetworkError(err, depth = 0) {
  if (err == null) return '';
  if (depth > 8) return '[depth limit]';
  if (typeof err !== 'object') return String(err);

  const e = /** @type {Record<string, unknown>} */ (err);
  const bits = [];
  if (typeof e.name === 'string') bits.push(e.name);
  if (typeof e.message === 'string' && e.message) bits.push(e.message);
  if (e.code) bits.push(`code=${e.code}`);
  if (e.errno != null) bits.push(`errno=${e.errno}`);
  if (typeof e.syscall === 'string') bits.push(`syscall=${e.syscall}`);
  if (typeof e.address === 'string') bits.push(`host=${e.address}`);
  if (e.port != null) bits.push(`port=${e.port}`);

  let line = bits.filter(Boolean).join(' ');

  const nested = e.errors;
  if (Array.isArray(nested) && nested.length) {
    const parts = nested
      .map((sub) => describeNetworkError(sub, depth + 1))
      .filter(Boolean);
    if (parts.length) {
      line = [line, `nested(${parts.length}): ${parts.join(' || ')}`].filter(Boolean).join(' · ');
    }
  }

  return line || String(err);
}
