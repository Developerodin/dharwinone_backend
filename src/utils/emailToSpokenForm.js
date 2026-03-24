/**
 * Convert an email to words safe for voice TTS (@ → "at", dots → "dot", etc.).
 * @param {string} [email]
 * @returns {string}
 */
export function emailToSpokenForm(email) {
  if (email == null || !String(email).trim()) return '';
  const s = String(email).trim();
  const parts = s.split('@');
  const segment = (t) =>
    t
      .replace(/\./g, ' dot ')
      .replace(/_/g, ' underscore ')
      .replace(/-/g, ' dash ')
      .replace(/\+/g, ' plus ');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return segment(s.replace(/@/g, ' at '))
      .replace(/\s+/g, ' ')
      .trim();
  }
  return `${segment(parts[0])} at ${segment(parts[1])}`.replace(/\s+/g, ' ').trim();
}
