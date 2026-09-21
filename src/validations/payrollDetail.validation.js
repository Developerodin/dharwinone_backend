import Joi from 'joi';
import { objectId } from './custom.validation.js';
import { PAYROLL_COUNTRIES, PATTERNS } from '../constants/payrollCountries.js';

/**
 * middlewares/validate.js compiles these with NO allowUnknown — an undeclared key
 * fails the entire request with a 400, not just that field. Every key here must match
 * the frontend spec in shared/lib/payroll/spec.ts exactly, and the backend must be
 * deployed before any frontend that sends a new key.
 *
 * Country-specific fields are `forbidden()` on the wrong country rather than merely
 * omitted. A US submission carrying an IFSC means the form rendered the wrong
 * country — better a loud 400 than a half-populated record nobody can pay from.
 */

const usBank = Joi.object().keys({
  accountHolderName: Joi.string().trim().max(120).required(),
  bankName: Joi.string().trim().max(120).required(),
  accountType: Joi.string().valid('checking', 'savings').required(),
  routingNumber: Joi.string().trim().pattern(PATTERNS.ABA_ROUTING).required().messages({
    'string.pattern.base': 'Routing number must be exactly 9 digits',
  }),
  accountNumber: Joi.string().trim().pattern(PATTERNS.ACCOUNT_US).required().messages({
    'string.pattern.base': 'Account number must be 1–17 digits',
  }),
  ifsc: Joi.any().forbidden(),
  branchName: Joi.any().forbidden(),
});

const inBank = Joi.object().keys({
  accountHolderName: Joi.string().trim().max(120).required(),
  bankName: Joi.string().trim().max(120).required(),
  accountType: Joi.string().valid('savings', 'current').required(),
  ifsc: Joi.string().trim().uppercase().pattern(PATTERNS.IFSC).required().messages({
    'string.pattern.base': 'IFSC must be 4 letters, then 0, then 6 letters or digits (e.g. HDFC0001234)',
  }),
  branchName: Joi.string().trim().max(120).allow('').optional(),
  accountNumber: Joi.string().trim().pattern(PATTERNS.ACCOUNT_IN).required().messages({
    'string.pattern.base': 'Account number must be 9–18 digits',
  }),
  routingNumber: Joi.any().forbidden(),
});

const usTax = Joi.object()
  .keys({
    /** Accepted with or without dashes; normalised to digits in the service. */
    ssn: Joi.string()
      .trim()
      .pattern(/^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$/)
      .optional()
      .messages({ 'string.pattern.base': 'SSN must be 9 digits' }),
    /**
     * "pending" and "itin" are first-class answers — the app hires on OPT/CPT, where
     * a pending SSN is normal. Only "provided" requires an actual number, enforced by
     * the custom check below rather than by .and(), which would wrongly require an
     * ssn whenever ssnStatus is present.
     */
    ssnStatus: Joi.string().valid('provided', 'pending', 'itin').required(),
    filingStatus: Joi.string()
      .valid('single_or_married_separately', 'married_jointly_or_surviving_spouse', 'head_of_household')
      .required(),
    multipleJobs: Joi.boolean().optional(),
    dependentsAmount: Joi.number().min(0).optional(),
    otherIncome: Joi.number().min(0).optional(),
    deductions: Joi.number().min(0).optional(),
    extraWithholding: Joi.number().min(0).optional(),
    workState: Joi.string().trim().uppercase().length(2).optional(),
    stateWithholdingDocumentIndex: Joi.number().integer().min(0).optional(),
    pan: Joi.any().forbidden(),
    taxRegime: Joi.any().forbidden(),
    form12bPreviousIncome: Joi.any().forbidden(),
    form12bPreviousTds: Joi.any().forbidden(),
    form12bbDocumentIndex: Joi.any().forbidden(),
  })
  .custom((value, helpers) => {
    if (value.ssnStatus === 'provided' && !value.ssn) {
      return helpers.message('An SSN is required when the status is "provided"');
    }
    return value;
  }, 'ssn presence');

const inTax = Joi.object().keys({
  pan: Joi.string()
    .trim()
    .uppercase()
    .pattern(PATTERNS.PAN)
    .required()
    .messages({ 'string.pattern.base': 'PAN must be 5 letters, 4 digits, then 1 letter (e.g. ABCDE1234F)' }),
  taxRegime: Joi.string().valid('new', 'old').required(),
  form12bPreviousIncome: Joi.number().min(0).optional(),
  form12bPreviousTds: Joi.number().min(0).optional(),
  form12bbDocumentIndex: Joi.number().integer().min(0).optional(),
  ssn: Joi.any().forbidden(),
  ssnStatus: Joi.any().forbidden(),
  filingStatus: Joi.any().forbidden(),
  multipleJobs: Joi.any().forbidden(),
  dependentsAmount: Joi.any().forbidden(),
  otherIncome: Joi.any().forbidden(),
  deductions: Joi.any().forbidden(),
  extraWithholding: Joi.any().forbidden(),
  workState: Joi.any().forbidden(),
  stateWithholdingDocumentIndex: Joi.any().forbidden(),
});

const inStatutory = Joi.object().keys({
  /** Optional by law — a private employer cannot compel Aadhaar. */
  aadhaar: Joi.string()
    .trim()
    .pattern(PATTERNS.AADHAAR)
    .optional()
    .messages({ 'string.pattern.base': 'Aadhaar must be 12 digits' }),
  uan: Joi.string()
    .trim()
    .pattern(PATTERNS.UAN)
    .optional()
    .messages({ 'string.pattern.base': 'UAN must be 12 digits' }),
  hasExistingUan: Joi.boolean().optional(),
  epfNominationDocumentIndex: Joi.number().integer().min(0).optional(),
  gratuityNominationDocumentIndex: Joi.number().integer().min(0).optional(),
  esicFamilyDocumentIndex: Joi.number().integer().min(0).optional(),
  // Derived server-side. Accepting these from a client would let a candidate assert
  // their own ESI status.
  pfApplicable: Joi.any().forbidden(),
  esiApplicable: Joi.any().forbidden(),
  monthlyGrossAtAssessment: Joi.any().forbidden(),
  applicabilityAssessedAt: Joi.any().forbidden(),
  i9DocumentIndex: Joi.any().forbidden(),
  i9CompletedAt: Joi.any().forbidden(),
});

const usStatutory = Joi.object().keys({
  i9DocumentIndex: Joi.number().integer().min(0).optional(),
  i9CompletedAt: Joi.date().optional(),
  aadhaar: Joi.any().forbidden(),
  uan: Joi.any().forbidden(),
  hasExistingUan: Joi.any().forbidden(),
  epfNominationDocumentIndex: Joi.any().forbidden(),
  gratuityNominationDocumentIndex: Joi.any().forbidden(),
  esicFamilyDocumentIndex: Joi.any().forbidden(),
  pfApplicable: Joi.any().forbidden(),
  esiApplicable: Joi.any().forbidden(),
  monthlyGrossAtAssessment: Joi.any().forbidden(),
  applicabilityAssessedAt: Joi.any().forbidden(),
});

const submitDetails = {
  params: Joi.object().keys({
    employeeId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      payrollCountry: Joi.string()
        .valid(...PAYROLL_COUNTRIES)
        .required(),
      bank: Joi.alternatives().conditional('payrollCountry', {
        is: 'US',
        then: usBank.required(),
        otherwise: inBank.required(),
      }),
      bankProofDocumentIndex: Joi.number().integer().min(0).optional(),
      tax: Joi.alternatives()
        .conditional('payrollCountry', { is: 'US', then: usTax, otherwise: inTax })
        .optional(),
      statutory: Joi.alternatives()
        .conditional('payrollCountry', { is: 'US', then: usStatutory, otherwise: inStatutory })
        .optional(),
    })
    .required(),
};

/** Candidate self-submit — same body, no employeeId param (it comes from the token). */
const submitMyDetails = {
  body: submitDetails.body,
};

const requestDetails = {
  params: Joi.object().keys({
    employeeId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      payrollCountry: Joi.string()
        .valid(...PAYROLL_COUNTRIES)
        .optional(),
      requestNotes: Joi.string().trim().max(500).allow('').optional(),
    })
    .required(),
};

const getDetails = {
  params: Joi.object().keys({
    employeeId: Joi.string().custom(objectId).required(),
  }),
};

const revealAccount = getDetails;

/** Cancel takes no body — the employeeId param is the whole request. */
const cancelRequest = getDetails;

const verifyDetails = {
  params: Joi.object().keys({
    employeeId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      approved: Joi.boolean().required(),
      // Required on reject so the candidate is told what to fix; forbidden on approve
      // so an approval cannot carry a stale reason from a previous rejection.
      rejectionReason: Joi.when('approved', {
        is: false,
        then: Joi.string().trim().min(3).max(500).required(),
        otherwise: Joi.any().forbidden(),
      }),
    })
    .required(),
};

export { requestDetails, cancelRequest, submitDetails, submitMyDetails, getDetails, revealAccount, verifyDetails };
