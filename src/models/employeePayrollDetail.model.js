import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import { PAYROLL_COUNTRIES } from '../constants/payrollCountries.js';

/**
 * Payroll and bank details for one Employee (the `candidates` collection covers both
 * candidates and staff).
 *
 * Why a separate collection rather than fields on Employee:
 *  - employee.service.js has ~40 `.lean()` calls, and `.lean()` bypasses the toJSON
 *    plugin's `private: true` stripping entirely. A `private` field on Employee is
 *    therefore not actually hidden.
 *  - Every holder of candidates.read reads the whole employee document. Putting these
 *    fields there would widen that read to bank and tax identifiers.
 *  - Retention: deleting a non-joiner's payroll data is one document delete here, and
 *    a field-by-field surgical unset on Employee.
 *
 * The service layer — not this model — encrypts and decrypts. A `.lean()` read of this
 * collection returns ciphertext, which is the safe default.
 */
const employeePayrollDetailSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      unique: true,
      index: true,
    },
    payrollCountry: {
      type: String,
      enum: [...PAYROLL_COUNTRIES],
      required: true,
    },
    /**
     * How payrollCountry was arrived at. Kept because a wrong country produces a form
     * asking for the wrong identifiers, and "who picked this" is the first question.
     */
    countrySource: {
      type: String,
      enum: ['offerCurrency', 'profileAddress', 'manual'],
      required: true,
    },
    status: {
      type: String,
      // requested → submitted → verified. rejected sends it back to the candidate,
      // who resubmits (status returns to submitted).
      enum: ['requested', 'submitted', 'verified', 'rejected'],
      default: 'requested',
      index: true,
    },
    bank: {
      accountHolderName: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountType: { type: String, enum: ['checking', 'savings', 'current'] },
      /** US only. Public identifier — printed on every cheque, so not encrypted. */
      routingNumber: { type: String, trim: true },
      /** India only. Public branch identifier, published in a directory. Not encrypted. */
      ifsc: { type: String, trim: true, uppercase: true },
      /** India. Derived from IFSC when supplied; free text otherwise. */
      branchName: { type: String, trim: true },
      /** AES-256-GCM, "v1:iv:tag:ct". See utils/fieldCrypto.js. */
      accountNumberEnc: { type: String, trim: true },
      /** Written on the same save as accountNumberEnc so the two cannot drift. */
      accountNumberLast4: { type: String, trim: true },
    },
    tax: {
      // ——— United States ———
      /** AES-256-GCM. See utils/fieldCrypto.js. */
      ssnEnc: { type: String, trim: true },
      ssnLast4: { type: String, trim: true },
      /**
       * An SSN is required to run payroll but NOT to submit this form. The app hires
       * on OPT/CPT (see Employee.sevisId / ead / visaType), where a pending SSN is
       * routine. Forcing a value here would produce fabricated numbers.
       */
      ssnStatus: { type: String, enum: ['provided', 'pending', 'itin'] },
      /** Form W-4 Step 1(c) wording. */
      filingStatus: {
        type: String,
        enum: ['single_or_married_separately', 'married_jointly_or_surviving_spouse', 'head_of_household'],
      },
      /** W-4 Step 2(c) checkbox. */
      multipleJobs: { type: Boolean, default: false },
      /** W-4 Step 3 total. */
      dependentsAmount: { type: Number, min: 0 },
      /** W-4 Step 4(a). */
      otherIncome: { type: Number, min: 0 },
      /** W-4 Step 4(b). */
      deductions: { type: Number, min: 0 },
      /** W-4 Step 4(c). */
      extraWithholding: { type: Number, min: 0 },
      /**
       * State withholding: most states tax income and many require their own
       * certificate (CA DE-4, NY IT-2104, …). Modelling 41 forms is out of scope —
       * store the state and a pointer to the uploaded certificate.
       *
       * Ceiling: the upgrade path, if state-level calculation is ever needed, is a
       * per-state spec module mirroring shared/lib/payroll/spec.ts — not more fields here.
       */
      workState: { type: String, trim: true, uppercase: true },
      stateWithholdingDocumentIndex: { type: Number, default: null },

      // ——— India ———
      panEnc: { type: String, trim: true },
      panLast4: { type: String, trim: true },
      taxRegime: { type: String, enum: ['new', 'old'] },
      /** Form 12B — previous employer income and TDS. NOT Form 12BB. */
      form12bPreviousIncome: { type: Number, min: 0 },
      form12bPreviousTds: { type: Number, min: 0 },
      /** Form 12BB — investment / HRA declaration, uploaded as a document. */
      form12bbDocumentIndex: { type: Number, default: null },
    },
    statutory: {
      // ——— India ———
      /**
       * Optional by law and by design: a private employer cannot compel Aadhaar. It is
       * asked for because EPFO requires an Aadhaar-seeded UAN, and the form says so.
       */
      aadhaarEnc: { type: String, trim: true },
      aadhaarLast4: { type: String, trim: true },
      uanEnc: { type: String, trim: true },
      uanLast4: { type: String, trim: true },
      hasExistingUan: { type: Boolean, default: false },
      /**
       * DERIVED, not declared. ESI applies at gross wages up to the statutory ceiling;
       * EPF has its own wage ceiling and an establishment-size condition. An employee
       * cannot know these and must not be asked to assert them — the values are
       * computed from the offer's monthly gross, and that input is stored alongside so
       * a stale assessment is visible rather than silent.
       */
      pfApplicable: { type: Boolean },
      esiApplicable: { type: Boolean },
      monthlyGrossAtAssessment: { type: Number },
      applicabilityAssessedAt: { type: Date },
      /**
       * Nominations — the items HR chases six months later, so they are tracked as
       * pointers rather than left loose in the document list.
       */
      epfNominationDocumentIndex: { type: Number, default: null },
      gratuityNominationDocumentIndex: { type: Number, default: null },
      esicFamilyDocumentIndex: { type: Number, default: null },

      // ——— United States ———
      /**
       * Form I-9 employment eligibility verification — legally required within three
       * business days of the start date. Dharwin already collects Passport, EAD Card
       * and I-765 Receipt, which are I-9 List A and List C documents; this field names
       * the obligation those uploads satisfy.
       *
       * Ceiling: a pointer and a date, not a modelled form. The I-9 has its own
       * signature, retention and re-verification rules; modelling it properly is a
       * separate project. Recording that it was completed, and when, is what this
       * system needs today.
       */
      i9DocumentIndex: { type: Number, default: null },
      i9CompletedAt: { type: Date },
    },
    /**
     * Index into Employee.documents[] of the uploaded bank proof (cancelled cheque or
     * statement). An index rather than an embedded copy, so the existing document
     * delete/verify machinery keeps working unchanged.
     *
     * Ceiling: Employee.documents is an array, so deleting an earlier document shifts
     * this index. deleteDocument already cascades documentRequests by index — the same
     * cascade must clear this field. Task 5 handles that.
     */
    bankProofDocumentIndex: { type: Number, default: null },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedAt: { type: Date },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    /** Free-text note from HR to the candidate, shown on the request card. */
    requestNotes: { type: String, trim: true },
  },
  { timestamps: true }
);

employeePayrollDetailSchema.plugin(toJSON);

const EmployeePayrollDetail = mongoose.model('EmployeePayrollDetail', employeePayrollDetailSchema);
export default EmployeePayrollDetail;
