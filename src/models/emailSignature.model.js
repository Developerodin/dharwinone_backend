import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const MAX_HTML_LENGTH = 65536;

const emailSignatureSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    html: {
      type: String,
      default: '',
      maxlength: MAX_HTML_LENGTH,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

emailSignatureSchema.plugin(toJSON);

/**
 * @typedef EmailSignature
 */
const EmailSignature = mongoose.model('EmailSignature', emailSignatureSchema);

export default EmailSignature;
export { MAX_HTML_LENGTH as EMAIL_SIGNATURE_MAX_HTML_LENGTH };
