import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * Admin-managed retail monthly price for purchasable Twilio numbers.
 * Use countryIso='*' and/or numberType='*' as wildcards.
 * Resolve order: exact → country+* → *+type → *+* → hard default $9.
 */
const NUMBER_TYPES = ['local', 'mobile', 'tollfree', '*'];

const numberPricingConfigSchema = new mongoose.Schema(
  {
    countryIso: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      // '*' = global default; otherwise ISO 3166-1 alpha-2
      maxlength: 2,
      validate: {
        validator(v) {
          return v === '*' || /^[A-Z]{2}$/.test(v);
        },
        message: 'countryIso must be * or a 2-letter ISO code',
      },
    },
    numberType: {
      type: String,
      required: true,
      enum: NUMBER_TYPES,
      default: '*',
    },
    monthlyPriceUsd: {
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
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

numberPricingConfigSchema.index({ countryIso: 1, numberType: 1 }, { unique: true });

numberPricingConfigSchema.plugin(toJSON);

const NumberPricingConfig = mongoose.model('NumberPricingConfig', numberPricingConfigSchema);
export default NumberPricingConfig;
export { NUMBER_TYPES };
