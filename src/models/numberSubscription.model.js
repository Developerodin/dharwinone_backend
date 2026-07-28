import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Monthly subscription for a user-purchased Twilio number.
 * Stripe fields are nullable until payment is wired; direct-buy uses paymentStatus=waived.
 */
const numberSubscriptionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    companyPhoneNumberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CompanyPhoneNumber',
      default: null,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    twilioSid: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due', 'incomplete'],
      default: 'active',
      index: true,
    },
    billingInterval: {
      type: String,
      enum: ['month'],
      default: 'month',
    },
    retailMonthlyPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'USD',
      trim: true,
      uppercase: true,
    },
    paymentStatus: {
      type: String,
      enum: ['waived', 'paid', 'unpaid', 'failed'],
      default: 'waived',
      index: true,
    },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    canceledAt: { type: Date, default: null },
    stripeCustomerId: { type: String, trim: true, default: null },
    stripeSubscriptionId: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

numberSubscriptionSchema.index({ userId: 1, status: 1 });
numberSubscriptionSchema.index(
  { companyPhoneNumberId: 1 },
  { unique: true, sparse: true },
);

numberSubscriptionSchema.pre('validate', function normalizePhone(next) {
  if (this.phoneNumber) {
    const raw = String(this.phoneNumber).trim();
    this.phoneNumber = raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`;
  }
  next();
});

numberSubscriptionSchema.plugin(toJSON);
numberSubscriptionSchema.plugin(paginate);

const NumberSubscription = mongoose.model('NumberSubscription', numberSubscriptionSchema);
export default NumberSubscription;
