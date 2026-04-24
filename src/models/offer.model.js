import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const ctcBreakdownSchema = new mongoose.Schema(
  {
    base: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    specialAllowances: { type: Number, default: 0 },
    otherAllowances: { type: Number, default: 0 },
    gross: { type: Number, default: 0 },
    currency: { type: String, default: 'INR', trim: true },
  },
  { _id: false }
);

const offerSchema = new mongoose.Schema(
  {
    offerCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    jobApplication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobApplication',
      required: true,
      index: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected'],
      default: 'Draft',
      index: true,
    },
    ctcBreakdown: {
      type: ctcBreakdownSchema,
      default: () => ({}),
    },
    joiningDate: {
      type: Date,
      index: true,
    },
    offerValidityDate: {
      type: Date,
      index: true,
    },
    offerLetterUrl: { type: String, trim: true },
    offerLetterKey: { type: String, trim: true },
    /** PDF offer letter (Draft editing / generation) */
    letterFullName: { type: String, trim: true },
    /** Full address line as printed on the letter */
    letterAddress: { type: String, trim: true },
    /** When set, overrides job title in the letter */
    positionTitle: { type: String, trim: true },
    /**
     * FT_40: Full time 40 hrs | PT_25: Part time 25 hrs | INTERN_UNPAID: unpaid training internship
     */
    jobType: {
      type: String,
      enum: ['FT_40', 'PT_25', 'INTERN_UNPAID'],
    },
    /** Display hours for intern (25 or 40) */
    weeklyHours: { type: Number, enum: [25, 40], default: 40 },
    workLocation: { type: String, trim: true, default: 'Remote (USA)' },
    roleResponsibilities: [{ type: String, trim: true }],
    trainingOutcomes: [{ type: String, trim: true }],
    /** Paid roles: full compensation sentence; optional if gross CTC is set */
    compensationNarrative: { type: String, trim: true },
    /** e.g. degree alignment (paid template) */
    academicAlignmentNote: { type: String, trim: true },
    employmentEligibilityLines: [{ type: String, trim: true }],
    supervisor: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true },
    },
    /** Shown in letter header; defaults to now when generating */
    letterDate: { type: Date },
    offerLetterGeneratedAt: { type: Date },
    sentAt: { type: Date },
    acceptedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    notes: { type: String, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

offerSchema.index({ status: 1, createdAt: -1 });
offerSchema.index({ candidate: 1 });
offerSchema.index({ job: 1 });

offerSchema.plugin(toJSON);
offerSchema.plugin(paginate);

/**
 * Generate unique offer code (e.g. OFF-2024-0001)
 */
offerSchema.statics.generateOfferCode = async function () {
  const year = new Date().getFullYear();
  const prefix = `OFF-${year}-`;
  const last = await this.findOne({ offerCode: new RegExp(`^${prefix}`) })
    .sort({ offerCode: -1 })
    .select('offerCode')
    .lean();
  let seq = 1;
  if (last?.offerCode) {
    const match = last.offerCode.match(new RegExp(`${prefix}(\\d+)`));
    if (match) seq = parseInt(match[1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
};

const Offer = mongoose.model('Offer', offerSchema);
export default Offer;
