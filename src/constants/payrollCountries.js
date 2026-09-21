/**
 * Payroll country support. Deliberately two countries: the app hires in the US and
 * India, and the Offer model's ctcBreakdown already carries both a USD default and an
 * `hra` line. Adding a third country means adding a code here, a Joi branch in
 * payrollDetail.validation.js, and a spec entry in the frontend — nothing else.
 *
 * NOTE: the frontend mirrors these regexes in shared/lib/payroll/spec.ts for inline
 * validation. They are duplicated across two repos on purpose — the backend copy is
 * the authority (it returns the 400), the frontend copy is UX. If you change one,
 * change the other.
 */

export const PAYROLL_COUNTRIES = Object.freeze(['US', 'IN']);

/**
 * Offer.ctcBreakdown.currency is the strongest country signal already in the database:
 * it is set per offer, is required to produce the offer letter, and describes which
 * payroll rails apply — unlike address.country, which is an optional free-text field
 * and is frequently blank on public-apply candidates.
 */
export const CURRENCY_TO_COUNTRY = Object.freeze({
  USD: 'US',
  INR: 'IN',
});

/**
 * Employee.address.country stores the ISO 3166 English short NAME (not a code) —
 * that is what shared/components/CountrySelect.tsx emits. Only the two supported
 * names are mapped; anything else falls through and HR picks manually.
 */
export const COUNTRY_NAME_TO_CODE = Object.freeze({
  'United States': 'US',
  India: 'IN',
});

export const PATTERNS = Object.freeze({
  /** 4 alpha bank code + literal 0 + 6 alphanumeric branch code. */
  IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  /** 5 alpha + 4 digit + 1 alpha. */
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  /** ABA routing transit number. */
  ABA_ROUTING: /^[0-9]{9}$/,
  /** IRS direct-deposit account number limit is 17 characters. */
  ACCOUNT_US: /^[0-9]{1,17}$/,
  /** Indian bank account numbers run 9–18 digits depending on the bank. */
  ACCOUNT_IN: /^[0-9]{9,18}$/,
  /** 12 digits; UIDAI never issues a number beginning 0 or 1. */
  AADHAAR: /^[2-9][0-9]{11}$/,
  UAN: /^[0-9]{12}$/,
  /** Match against digits only — strip dashes before testing. */
  SSN: /^[0-9]{9}$/,
});

/**
 * Statutory thresholds, as of 2026-09. These are policy numbers set by EPFO and ESIC,
 * not code constants — when either is revised, change it here and re-assess affected
 * employees. `monthlyGrossAtAssessment` on each record is what makes a stale
 * assessment findable.
 */
export const INDIA_THRESHOLDS = Object.freeze({
  /** ESI covers employees earning up to this monthly gross. */
  ESI_MONTHLY_GROSS_CEILING: 21000,
  /** EPF statutory wage ceiling — caps the contribution base, not eligibility. */
  EPF_MONTHLY_WAGE_CEILING: 15000,
});
