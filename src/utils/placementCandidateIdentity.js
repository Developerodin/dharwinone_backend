/**
 * Pre-boarding / onboarding lists: placements whose Employee (candidate) no longer exists
 * or has no displayable name/email are hidden from API lists (deleted candidate, empty stub).
 * Shared by placement queries and the candidate-role promotion scheduler so counts match Onboarding UI.
 *
 * @param {object|null|undefined} emp - Populated Employee or lean doc
 * @returns {boolean}
 */
export function placementCandidateHasDisplayIdentity(emp) {
  if (!emp || !emp._id) return false;
  const fn = String(emp.fullName ?? '').trim();
  const em = String(emp.email ?? '').trim();
  const bad = new Set(['-', '—', 'n/a', 'na', 'none', 'tbd']);
  if (fn.length > 0 && !bad.has(fn.toLowerCase())) return true;
  if (em.length > 0 && !bad.has(em.toLowerCase()) && em.includes('@')) return true;
  return false;
}
