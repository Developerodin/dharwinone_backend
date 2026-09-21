import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import EmployeePayrollDetail from '../models/employeePayrollDetail.model.js';
import Employee from '../models/employee.model.js';
import Offer from '../models/offer.model.js';
import { encryptField, decryptField, last4 } from '../utils/fieldCrypto.js';
import { CURRENCY_TO_COUNTRY, COUNTRY_NAME_TO_CODE, INDIA_THRESHOLDS } from '../constants/payrollCountries.js';

/**
 * Decide which country's payroll form applies.
 *
 * Order, strongest first:
 *  1. Whatever was already saved — once a human has chosen, stop guessing.
 *  2. Offer.ctcBreakdown.currency — set per offer, required to produce the offer
 *     letter, and describes the payroll rails rather than where the person sleeps.
 *  3. Employee.address.country — optional free text, frequently blank. Last resort.
 *  4. null — the panel asks HR. Never default to a country.
 *
 * Pure function: no database access, so it is directly testable.
 */
export const resolvePayrollCountry = ({ existing, offer, employee }) => {
  if (existing?.payrollCountry) {
    return { country: existing.payrollCountry, source: existing.countrySource || 'manual' };
  }
  const currency = String(offer?.ctcBreakdown?.currency || '').trim().toUpperCase();
  if (CURRENCY_TO_COUNTRY[currency]) {
    return { country: CURRENCY_TO_COUNTRY[currency], source: 'offerCurrency' };
  }
  const name = String(employee?.address?.country || '').trim();
  if (COUNTRY_NAME_TO_CODE[name]) {
    return { country: COUNTRY_NAME_TO_CODE[name], source: 'profileAddress' };
  }
  return { country: null, source: null };
};

/**
 * Derive PF and ESI applicability from monthly gross.
 *
 * PF eligibility is not capped by the wage ceiling — the ceiling caps the contribution
 * base. Anyone in a covered establishment is eligible, so pfApplicable is true whenever
 * a gross is known.
 *
 * Ceiling: this ignores the 20-employee establishment condition, because Dharwin is a
 * single covered establishment. If the product ever serves multiple employers, this
 * needs the employer's headcount as an input.
 */
export const deriveIndiaStatutory = (monthlyGross) => {
  const gross = Number(monthlyGross);
  if (!Number.isFinite(gross) || gross <= 0) {
    return { monthlyGrossAtAssessment: undefined, applicabilityAssessedAt: undefined };
  }
  return {
    pfApplicable: true,
    esiApplicable: gross <= INDIA_THRESHOLDS.ESI_MONTHLY_GROSS_CEILING,
    monthlyGrossAtAssessment: gross,
    applicabilityAssessedAt: new Date(),
  };
};

/**
 * The ONLY shape that leaves this service for a client. Ciphertext and plaintext
 * account numbers both stop here; the single exception is revealAccountNumber, which
 * is separately permissioned and separately audited.
 */
export const toMaskedView = (doc) => {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const bank = plain.bank || {};
  const tail = bank.accountNumberLast4 || '';
  const tax = plain.tax || {};
  const ssnTail = tax.ssnLast4 || '';
  const panTail = tax.panLast4 || '';
  const statutory = plain.statutory || {};
  const aadhaarTail = statutory.aadhaarLast4 || '';
  const uanTail = statutory.uanLast4 || '';
  return {
    id: plain.id || (plain._id ? String(plain._id) : undefined),
    payrollCountry: plain.payrollCountry,
    countrySource: plain.countrySource,
    status: plain.status,
    requestNotes: plain.requestNotes,
    rejectionReason: plain.rejectionReason,
    requestedAt: plain.requestedAt,
    submittedAt: plain.submittedAt,
    verifiedAt: plain.verifiedAt,
    bankProofDocumentIndex: plain.bankProofDocumentIndex ?? null,
    bank: {
      accountHolderName: bank.accountHolderName || '',
      bankName: bank.bankName || '',
      accountType: bank.accountType || '',
      routingNumber: bank.routingNumber || '',
      ifsc: bank.ifsc || '',
      branchName: bank.branchName || '',
      accountNumberLast4: tail,
      accountNumberMasked: tail ? `\u2022\u2022\u2022\u2022${tail}` : '',
    },
    tax: {
      ssnStatus: tax.ssnStatus || '',
      ssnLast4: ssnTail,
      ssnMasked: ssnTail ? `\u2022\u2022\u2022-\u2022\u2022-${ssnTail}` : '',
      filingStatus: tax.filingStatus || '',
      multipleJobs: Boolean(tax.multipleJobs),
      dependentsAmount: tax.dependentsAmount ?? null,
      otherIncome: tax.otherIncome ?? null,
      deductions: tax.deductions ?? null,
      extraWithholding: tax.extraWithholding ?? null,
      workState: tax.workState || '',
      stateWithholdingDocumentIndex: tax.stateWithholdingDocumentIndex ?? null,
      panLast4: panTail,
      panMasked: panTail ? `\u2022\u2022\u2022\u2022\u2022\u2022${panTail}` : '',
      taxRegime: tax.taxRegime || '',
      form12bPreviousIncome: tax.form12bPreviousIncome ?? null,
      form12bPreviousTds: tax.form12bPreviousTds ?? null,
      form12bbDocumentIndex: tax.form12bbDocumentIndex ?? null,
    },
    statutory: {
      hasExistingUan: Boolean(statutory.hasExistingUan),
      aadhaarLast4: aadhaarTail,
      aadhaarMasked: aadhaarTail ? `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${aadhaarTail}` : '',
      uanLast4: uanTail,
      uanMasked: uanTail ? `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${uanTail}` : '',
      pfApplicable: statutory.pfApplicable ?? null,
      esiApplicable: statutory.esiApplicable ?? null,
      monthlyGrossAtAssessment: statutory.monthlyGrossAtAssessment ?? null,
      applicabilityAssessedAt: statutory.applicabilityAssessedAt ?? null,
      epfNominationDocumentIndex: statutory.epfNominationDocumentIndex ?? null,
      gratuityNominationDocumentIndex: statutory.gratuityNominationDocumentIndex ?? null,
      esicFamilyDocumentIndex: statutory.esicFamilyDocumentIndex ?? null,
      i9DocumentIndex: statutory.i9DocumentIndex ?? null,
      i9CompletedAt: statutory.i9CompletedAt ?? null,
    },
  };
};

const loadEmployeeOrThrow = async (employeeId) => {
  const employee = await Employee.findById(employeeId);
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'Employee not found');
  return employee;
};

/**
 * HR asks the candidate for their details. Creates the record in `requested` state.
 * Idempotent on re-request: an existing record is updated rather than a second row
 * created (the unique index would reject one anyway).
 */
export const requestPayrollDetails = async (employeeId, { payrollCountry, requestNotes }, user) => {
  const employee = await loadEmployeeOrThrow(employeeId);
  const existing = await EmployeePayrollDetail.findOne({ employee: employeeId });
  const offer = await Offer.findOne({ candidate: employeeId }).sort({ createdAt: -1 });

  const resolved = payrollCountry
    ? { country: payrollCountry, source: 'manual' }
    : resolvePayrollCountry({ existing, offer, employee });

  if (!resolved.country) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Payroll country could not be determined from the offer or profile — select one before requesting details'
    );
  }

  const doc =
    existing ||
    new EmployeePayrollDetail({
      employee: employeeId,
      payrollCountry: resolved.country,
      countrySource: resolved.source,
    });

  doc.payrollCountry = resolved.country;
  doc.countrySource = resolved.source;
  doc.requestNotes = requestNotes ? String(requestNotes).trim() : undefined;
  doc.requestedBy = user._id || user.id;
  doc.requestedAt = new Date();
  // Re-requesting a rejected or verified record puts it back in the candidate's queue.
  doc.status = 'requested';
  doc.rejectionReason = undefined;
  await doc.save();
  return toMaskedView(doc);
};

/**
 * Candidate (or HR on their behalf) submits the values. Writes the ciphertext and the
 * last-4 mirror in the same save so they cannot drift.
 */
export const submitPayrollDetails = async (employeeId, payload, user) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'No payroll details have been requested for this person');

  const { accountNumber, ...rest } = payload.bank || {};
  doc.bank = doc.bank || {};
  doc.bank.accountHolderName = rest.accountHolderName;
  doc.bank.bankName = rest.bankName;
  doc.bank.accountType = rest.accountType;
  doc.bank.routingNumber = rest.routingNumber;
  doc.bank.ifsc = rest.ifsc;
  doc.bank.branchName = rest.branchName;

  if (accountNumber) {
    doc.bank.accountNumberEnc = encryptField(accountNumber);
    doc.bank.accountNumberLast4 = last4(accountNumber);
  }
  if (Number.isInteger(payload.bankProofDocumentIndex)) {
    doc.bankProofDocumentIndex = payload.bankProofDocumentIndex;
  }

  if (payload.tax) {
    const { ssn, pan, ...taxRest } = payload.tax;
    const currentTax = doc.tax
      ? typeof doc.tax.toObject === 'function'
        ? doc.tax.toObject()
        : doc.tax
      : {};
    doc.tax = { ...currentTax, ...taxRest };
    if (ssn) {
      const digits = String(ssn).replace(/-/g, '');
      doc.tax.ssnEnc = encryptField(digits);
      doc.tax.ssnLast4 = last4(digits);
    }
    if (pan) {
      const upper = String(pan).trim().toUpperCase();
      doc.tax.panEnc = encryptField(upper);
      doc.tax.panLast4 = last4(upper);
    }
    doc.markModified('tax');
  }

  if (payload.statutory) {
    const { aadhaar, uan, ...statRest } = payload.statutory;
    const currentStat = doc.statutory
      ? typeof doc.statutory.toObject === 'function'
        ? doc.statutory.toObject()
        : doc.statutory
      : {};
    doc.statutory = { ...currentStat, ...statRest };
    if (aadhaar) {
      doc.statutory.aadhaarEnc = encryptField(String(aadhaar));
      doc.statutory.aadhaarLast4 = last4(String(aadhaar));
    }
    if (uan) {
      doc.statutory.uanEnc = encryptField(String(uan));
      doc.statutory.uanLast4 = last4(String(uan));
    }
    if (doc.payrollCountry === 'IN') {
      const offer = await Offer.findOne({ candidate: doc.employee }).sort({ createdAt: -1 });
      const annualGross = Number(offer?.ctcBreakdown?.gross);
      Object.assign(doc.statutory, deriveIndiaStatutory(annualGross > 0 ? annualGross / 12 : null));
    }
    doc.markModified('statutory');
  }

  doc.status = 'submitted';
  doc.rejectionReason = undefined;
  doc.submittedBy = user._id || user.id;
  doc.submittedAt = new Date();
  await doc.save();
  return toMaskedView(doc);
};

export const getPayrollDetails = async (employeeId) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  return toMaskedView(doc);
};

/**
 * Withdraw an outstanding request. Deletes the record rather than moving it to a
 * 'cancelled' status, which is safe only because a 'requested' record holds nothing
 * the candidate entered — just the country, the note, and who asked when. The
 * activity log keeps that history.
 *
 * Deleting also restores the correct candidate-side behaviour for free: getMyDetails
 * returns null, so PayrollDetailsActionCard renders nothing, instead of leaving a
 * cancelled card the person cannot act on.
 *
 * Any other status means the candidate HAS submitted bank details, so this refuses.
 * Discarding a submitted account number is a different and far more destructive act
 * than un-asking, and must not share a button with it.
 */
export const cancelPayrollRequest = async (employeeId, user) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'No payroll details request on file');
  if (doc.status !== 'requested') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot cancel a request that is already "${doc.status}" — bank details have been submitted`
    );
  }
  const snapshot = {
    payrollCountry: doc.payrollCountry,
    countrySource: doc.countrySource,
    requestedAt: doc.requestedAt,
    cancelledBy: String(user._id || user.id),
  };
  await EmployeePayrollDetail.deleteOne({ _id: doc._id });
  return snapshot;
};

/**
 * The only path that returns a full account number. Separately permissioned and
 * audited by the controller — the audit row is the whole point of this being its own
 * endpoint rather than a flag on the GET.
 */
export const revealAccountNumber = async (employeeId) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  if (!doc?.bank?.accountNumberEnc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No account number on file');
  }
  return { accountNumber: decryptField(doc.bank.accountNumberEnc) };
};

export const verifyPayrollDetails = async (employeeId, { approved, rejectionReason }, user) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'No payroll details on file');
  if (doc.status !== 'submitted') {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot verify details with status "${doc.status}"`);
  }
  if (approved) {
    doc.status = 'verified';
    doc.rejectionReason = undefined;
  } else {
    doc.status = 'rejected';
    doc.rejectionReason = String(rejectionReason || '').trim() || 'Rejected without a stated reason';
  }
  doc.verifiedBy = user._id || user.id;
  doc.verifiedAt = new Date();
  await doc.save();
  return toMaskedView(doc);
};

/**
 * Employee.documents is an array, so deleting an entry shifts every later index.
 * Called from the existing document-delete cascade.
 */
export const clearBankProofIndex = async (employeeId, deletedIndex) => {
  const doc = await EmployeePayrollDetail.findOne({ employee: employeeId });
  if (!doc || doc.bankProofDocumentIndex === null || doc.bankProofDocumentIndex === undefined) return;
  if (doc.bankProofDocumentIndex === deletedIndex) {
    doc.bankProofDocumentIndex = null;
  } else if (doc.bankProofDocumentIndex > deletedIndex) {
    doc.bankProofDocumentIndex -= 1;
  } else {
    return;
  }
  await doc.save();
};
