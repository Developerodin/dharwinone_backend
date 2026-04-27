import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const qualificationSchema = new mongoose.Schema(
  {
    degree: { type: String, required: true, trim: true },
    institute: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    startYear: { type: Number },
    endYear: { type: Number },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const experienceSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    currentlyWorking: { type: Boolean, default: false },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const DOCUMENT_TYPES = ['Resume', 'Aadhar', 'PAN', 'Bank', 'Passport', 'Other'];

const documentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DOCUMENT_TYPES, default: 'Other', trim: true },
    label: { type: String, trim: true },
    url: { type: String, trim: true },
    key: { type: String, trim: true },
    originalName: { type: String, trim: true },
    size: { type: Number },
    mimeType: { type: String, trim: true },
    status: { type: Number, default: 0 },
    adminNotes: { type: String, trim: true },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const skillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], default: 'Beginner' },
    category: { type: String, trim: true },
  },
  { _id: false }
);

const socialLinkSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const salarySlipSchema = new mongoose.Schema(
  {
    month: { type: String, trim: true },
    year: { type: Number, min: 1900, max: 2100 },
    documentUrl: { type: String, trim: true },
    key: { type: String, trim: true },
    originalName: { type: String, trim: true },
    size: { type: Number },
    mimeType: { type: String, trim: true },
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: String, trim: true, unique: true, sparse: true, index: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    /** Company-provided work mailbox (Google Workspace / M365); distinct from login email. */
    companyAssignedEmail: { type: String, trim: true, lowercase: true, default: '', index: true },
    companyEmailProvider: {
      type: String,
      enum: ['gmail', 'outlook', 'unknown', ''],
      default: '',
    },
    phoneNumber: { type: String, required: true, trim: true },
    profilePicture: {
      url: { type: String, trim: true },
      key: { type: String, trim: true },
      originalName: { type: String, trim: true },
      size: { type: Number },
      mimeType: { type: String, trim: true },
    },
    shortBio: { type: String, trim: true },
    sevisId: { type: String, trim: true },
    ead: { type: String, trim: true },
    visaType: { type: String, trim: true },
    customVisaType: { type: String, trim: true },
    countryCode: { type: String, trim: true },
    degree: { type: String, trim: true },
    supervisorName: { type: String, trim: true },
    supervisorContact: { type: String, trim: true },
    supervisorCountryCode: { type: String, trim: true },
    salaryRange: { type: String, trim: true },
    address: {
      streetAddress: { type: String, trim: true },
      streetAddress2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true },
    },
    qualifications: { type: [qualificationSchema], default: [] },
    experiences: { type: [experienceSchema], default: [] },
    documents: { type: [documentSchema], default: [] },
    skills: { type: [skillSchema], default: [] },
    socialLinks: { type: [socialLinkSchema], default: [] },
    salarySlips: { type: [salarySlipSchema], default: [] },
    isProfileCompleted: { type: Number, default: 0, min: 0, max: 100 },
    isCompleted: { type: Boolean, default: false },
    recruiterNotes: [
      {
        note: { type: String, trim: true, required: true },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    recruiterFeedback: { type: String, trim: true },
    recruiterRating: { type: Number, min: 1, max: 5 },
    assignedRecruiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** Training staff (Agent role) responsible for this student — Settings → Agents. */
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    joiningDate: { type: Date, index: true },
    resignDate: { type: Date, index: true },
    isActive: { type: Boolean, default: true, index: true },
    weekOff: {
      type: [String],
      enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      default: [],
      index: true,
    },
    holidays: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Holiday' }],
      default: [],
      index: true,
    },
    leaves: [
      {
        date: { type: Date, required: true, index: true },
        leaveType: { type: String, enum: ['casual', 'sick', 'unpaid'], required: true },
        notes: { type: String, trim: true },
        assignedAt: { type: Date, default: Date.now },
      },
    ],
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null, index: true },
    department: { type: String, trim: true, index: true },
    designation: { type: String, trim: true, index: true },
    // Position (ref to Position - Java Developer, Data Analyst, etc.) - used during onboarding
    position: { type: mongoose.Schema.Types.ObjectId, ref: 'Position', default: null, index: true },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** Referral attribution (HMAC ref token claim at registration / job flows). */
    referredByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referralContext: {
      type: String,
      enum: ['SHARE_CANDIDATE_ONBOARD', 'JOB_APPLY'],
      default: null,
    },
    referralJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
    /** Denormalized job title for list/export when ref is job-scoped. */
    referralJobTitle: { type: String, trim: true, default: null },
    referredAt: { type: Date, default: null, index: true },
    referralBatchId: { type: String, trim: true, default: null },
    /** Idempotency for token verify (FVCW / revocation lookup). */
    referralJti: { type: String, trim: true, default: null, index: true, sparse: true },
    /** When set, first successful claim is final unless admin overrides. */
    attributionLockedAt: { type: Date, default: null },
    /** GDPR: suppress personal attribution in UI while keeping audit internally if needed. */
    referralAttributionAnonymised: { type: Boolean, default: false },
    referralPipelineStatus: {
      type: String,
      enum: ['profile_complete', 'applied', 'in_review', 'hired', 'rejected', 'pending', 'withdrawn'],
      default: 'pending',
    },
    /** Most recent override audit (older chain can move to collection later). */
    referralLastOverride: {
      previousReferredByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      newReferredByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: { type: String, trim: true },
      overriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      overriddenAt: { type: Date },
    },
  },
  { timestamps: true }
);

employeeSchema.pre('save', async function (next) {
  if (this.isNew && (!this.employeeId || this.employeeId.trim() === '')) {
    try {
      const candidatesWithIds = await this.constructor
        .find({ employeeId: { $exists: true, $ne: null, $regex: /^DBS\d+$/i } }, { employeeId: 1 })
        .lean();
      let maxNumber = 0;
      candidatesWithIds.forEach((candidate) => {
        if (candidate.employeeId) {
          const match = candidate.employeeId.match(/^DBS(\d+)$/i);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
      });
      this.employeeId = `DBS${maxNumber + 1}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

employeeSchema.pre('save', function (next) {
  if (this.isModified('companyAssignedEmail') && this.companyAssignedEmail) {
    this.companyAssignedEmail = String(this.companyAssignedEmail).toLowerCase().trim();
  }
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (this.resignDate) {
    const resignDate = new Date(this.resignDate);
    resignDate.setHours(0, 0, 0, 0);
    this.isActive = resignDate > now;
  } else if (this.isModified('resignDate') && !this.resignDate) {
    this.isActive = true;
  }
  next();
});

// Resigned employees must keep their employee ID for records; do not allow clearing or changing it.
employeeSchema.pre('save', async function (next) {
  if (this.isNew || !this.resignDate || !this.isModified('employeeId')) return next();
  try {
    const existing = await this.constructor.findById(this._id).select('employeeId').lean();
    if (existing?.employeeId) this.employeeId = existing.employeeId;
  } catch (err) {
    return next(err);
  }
  next();
});

employeeSchema.index({ referredByUserId: 1, referredAt: -1 });
employeeSchema.index({ 'skills.name': 'text' });
employeeSchema.plugin(toJSON);
employeeSchema.plugin(paginate);

/** Registered model name `Employee`; persisted collection name remains `candidates` (legacy / no DB migration). */
const Employee = mongoose.model('Employee', employeeSchema, 'candidates');
export default Employee;
