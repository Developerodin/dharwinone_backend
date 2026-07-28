import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const companyPhoneNumberSchema = mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['twilio', 'plivo'],
      default: 'twilio',
      index: true,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    friendlyName: { type: String, trim: true, default: '' },
    twilioSid: { type: String, trim: true, default: '', index: true },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TeamGroup',
      default: null,
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    capabilities: {
      voice: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
    },
    /** ISO 3166-1 alpha-2 of the purchased number (e.g. US). */
    isoCountry: { type: String, trim: true, uppercase: true, default: '', maxlength: 2 },
    /** Twilio number type used at purchase. */
    numberType: {
      type: String,
      enum: ['local', 'mobile', 'tollfree', ''],
      default: '',
    },
    /** Retail monthly price charged to the user (USD). */
    retailMonthlyPrice: { type: Number, default: null, min: 0 },
    /** Link to the monthly NumberSubscription for this number. */
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NumberSubscription',
      default: null,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

companyPhoneNumberSchema.index({ tenantId: 1, phoneNumber: 1 }, { unique: true });
companyPhoneNumberSchema.index({ tenantId: 1, isActive: 1, assignedTo: 1 });

companyPhoneNumberSchema.pre('validate', function normalizePhone(next) {
  if (this.phoneNumber) {
    const raw = String(this.phoneNumber).trim();
    this.phoneNumber = raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`;
  }
  next();
});

companyPhoneNumberSchema.plugin(toJSON);

const CompanyPhoneNumber = mongoose.model('CompanyPhoneNumber', companyPhoneNumberSchema);
export default CompanyPhoneNumber;
