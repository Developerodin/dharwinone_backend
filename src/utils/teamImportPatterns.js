export const IGNORED_NAME_PATTERNS = [
  /\btest\b/i, /\bdummy\b/i, /\bdemo\b/i, /\bsample\b/i,
  /\bresigned\b/i, /\bterminated\b/i, /\bex[\s-]?employee\b/i,
  /\bbench\b/i, /\barchived\b/i, /\binactive\b/i,
];
export const IGNORED_EMAIL_PATTERNS = [
  /^test/i, /^noreply@/i, /^no-reply@/i, /^dummy/i, /^demo/i,
];

export function isIgnoredEmployee(emp) {
  if (!emp)                   return { ignored: true, reason: 'employee_not_found' };
  if (emp.isActive === false) return { ignored: true, reason: 'inactive_or_resigned' };
  const name = String(emp.name || '').trim();
  if (IGNORED_NAME_PATTERNS.some((re) => re.test(name)))
    return { ignored: true, reason: 'dummy_name_pattern' };
  const email = String(emp.email || '').trim().toLowerCase();
  if (IGNORED_EMAIL_PATTERNS.some((re) => re.test(email)))
    return { ignored: true, reason: 'dummy_email_pattern' };
  return { ignored: false };
}
