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
      ref: 'Candidate',
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
