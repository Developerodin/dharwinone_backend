/**
 * Canonical identity field pairs. User is the single source of truth;
 * Employee (collection `candidates`) holds a mirror cache of these fields.
 * See docs/superpowers/specs/2026-08-04-identity-write-path-normalization-design.md
 */
export const IDENTITY_FIELD_MAP = [
  { user: 'name', employee: 'fullName' },
  { user: 'email', employee: 'email' },
  { user: 'phoneNumber', employee: 'phoneNumber' },
  { user: 'countryCode', employee: 'countryCode' },
  { user: 'profilePicture', employee: 'profilePicture' },
];

const picId = (pic) => (pic && (pic.key || pic.url)) || '';
const isEmpty = (field, v) => (field === 'profilePicture' ? !picId(v) : v === null || v === undefined || v === '');

/**
 * Patch to apply on the Employee mirror after a User identity change.
 * Only fields present in `userValues` are considered.
 */
export const buildEmployeeMirrorPatch = (userValues, employee) => {
  const patch = {};
  for (const { user: uf, employee: ef } of IDENTITY_FIELD_MAP) {
    if (!Object.prototype.hasOwnProperty.call(userValues, uf)) continue;
    const raw = userValues[uf];
    if (uf === 'name') {
      const v = raw == null ? '' : String(raw).trim();
      if (v && v !== employee[ef]) patch[ef] = v;
    } else if (uf === 'email') {
      const v = raw == null ? '' : String(raw).trim().toLowerCase();
      if (v && v !== employee[ef]) patch[ef] = v;
    } else if (uf === 'phoneNumber') {
      const v = raw == null ? '' : String(raw).trim();
      // Employee.phoneNumber is required — an empty User phone must not clear it.
      if (v && v !== employee[ef]) patch[ef] = v;
    } else if (uf === 'countryCode') {
      const v = raw == null || raw === '' ? undefined : String(raw).trim();
      if (v !== employee[ef]) patch[ef] = v;
    } else {
      const next = raw == null ? undefined : raw;
      if (picId(next) !== picId(employee[ef])) patch[ef] = next;
    }
  }
  return patch;
};

/**
 * Shared convergence rule for backfill + reconciler.
 * Per field: User non-empty wins downward; User empty adopts Employee's value upward.
 */
export const computeIdentityConvergence = (user, employee) => {
  const userSet = {};
  const employeeSet = {};
  for (const { user: uf, employee: ef } of IDENTITY_FIELD_MAP) {
    const uv = user[uf];
    const ev = employee[ef];
    const differs = uf === 'profilePicture' ? picId(uv) !== picId(ev) : uv !== ev;
    if (!isEmpty(uf, uv)) {
      if (differs) employeeSet[ef] = uv;
    } else if (!isEmpty(uf, ev)) {
      userSet[uf] = ev;
    }
  }
  return { userSet, employeeSet };
};

/**
 * Synthetic offer-letter candidates carry a generated relay address (offer.service.js).
 * They are placeholders, never a real person's identity mirror.
 */
export const SYNTHETIC_EMAIL_RE = /\.noreply@dharwin\.offers\.local$/i;

/**
 * Which Employee doc mirrors a User's identity. An owner can hold several profiles
 * (recruiter-created candidate records, offer placeholders), and guessing wrong stamps
 * someone else's name and email onto a real person. Returns null when undecidable —
 * callers must skip, never fall back to "first match".
 *
 * `matchEmails` are addresses the User is known by (current and pre-update), used only
 * to break a tie between multiple real profiles.
 */
export const pickMirrorEmployee = (matchEmails, employees) => {
  const real = (employees || []).filter((e) => !SYNTHETIC_EMAIL_RE.test(e?.email || ''));
  if (real.length <= 1) return real[0] || null;
  const wanted = new Set((matchEmails || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()));
  const hits = real.filter((e) => wanted.has(String(e.email || '').toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
};

const EMPLOYEE_IDENTITY_FIELDS = IDENTITY_FIELD_MAP.map((p) => p.employee);

/** Employee-side identity fields present in modifiedPaths, unless the doc is new or the mirror flagged the write. */
export const detectDirectIdentityWrite = (modifiedPaths, isNew, mirrorFlag) => {
  if (isNew || mirrorFlag) return [];
  const hits = new Set();
  for (const p of modifiedPaths || []) {
    const root = String(p).split('.')[0];
    if (EMPLOYEE_IDENTITY_FIELDS.includes(root)) hits.add(root);
  }
  return [...hits];
};
