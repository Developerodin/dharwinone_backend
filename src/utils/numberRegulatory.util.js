/**
 * Regulatory / verification gates derived from Twilio catalogue data.
 * No hardcoded country lists — use addressRequirements on numbers and
 * Twilio Regulatory Compliance regulations for country + number type.
 */

export const REQUIRES_VERIFICATION_MESSAGE =
  'This number requires verification documents (coming soon).';

/**
 * Twilio `address_requirements` on an available number.
 * @param {string|null|undefined} addressRequirements `none` | `any` | `local` | `foreign`
 * @returns {boolean}
 */
export function addressRequiresVerification(addressRequirements) {
  if (addressRequirements == null || addressRequirements === '') return false;
  return String(addressRequirements).trim().toLowerCase() !== 'none';
}

/**
 * Whether Twilio Regulations API entries require identity / document compliance.
 * @param {Array<{ requirements?: unknown }>} regulations
 * @returns {boolean}
 */
export function regulationRequiresVerification(regulations = []) {
  if (!Array.isArray(regulations) || regulations.length === 0) return false;
  return regulations.some((reg) => hasSubstantiveRequirements(reg?.requirements));
}

/**
 * @param {unknown} requirements Twilio regulation requirements object
 * @returns {boolean}
 */
export function hasSubstantiveRequirements(requirements) {
  if (requirements == null) return false;

  let req = requirements;
  if (typeof req === 'string') {
    try {
      req = JSON.parse(req);
    } catch {
      return false;
    }
  }
  if (typeof req !== 'object') return false;

  const supporting =
    req.supporting_document ??
    req.supportingDocument ??
    req.supporting_documents ??
    req.supportingDocuments;
  if (Array.isArray(supporting) && supporting.length > 0) {
    const flat = supporting.flat(Infinity).filter(Boolean);
    if (flat.length > 0) return true;
  }

  const endUser = req.end_user ?? req.endUser;
  if (Array.isArray(endUser) && endUser.length > 0) return true;
  if (endUser && typeof endUser === 'object' && Object.keys(endUser).length > 0) return true;

  const bundle = req.bundle ?? req.Bundle;
  if (bundle && typeof bundle === 'object' && Object.keys(bundle).length > 0) return true;

  return false;
}

/**
 * Combined gate from Twilio number + regulation data.
 * @param {{ addressRequirements?: string|null, regulations?: Array<{ requirements?: unknown }> }} opts
 * @returns {boolean}
 */
export function computeRequiresVerification({ addressRequirements, regulations } = {}) {
  if (addressRequiresVerification(addressRequirements)) return true;
  if (regulationRequiresVerification(regulations)) return true;
  return false;
}

/** @deprecated Use computeRequiresVerification — kept for internal importers. */
export function numberRequiresVerification(opts = {}) {
  return computeRequiresVerification(opts);
}

/**
 * Map internal number type to Twilio Regulations API NumberType values.
 * @param {string} numberType
 * @returns {string}
 */
export function toTwilioRegulationNumberType(numberType) {
  const t = String(numberType || 'local').toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'tollfree') return 'toll-free';
  if (t === 'mobile') return 'mobile';
  if (t === 'national') return 'national';
  return 'local';
}

/**
 * Map internal search type to Twilio AvailablePhoneNumbers subresource key.
 * @param {string} numberType
 * @returns {'local'|'mobile'|'tollFree'}
 */
export function toTwilioSearchNumberType(numberType) {
  const t = String(numberType || 'local').toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'tollfree') return 'tollFree';
  if (t === 'mobile') return 'mobile';
  return 'local';
}
