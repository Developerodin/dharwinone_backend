import mongoose from 'mongoose';

/**
 * Email audit log. Records every email sent or failed for debugging and compliance.
 */
const emailLogSchema = mongoose.Schema(
  {
    to: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    subject: {
      type: String,
      required: true,
    },
    templateName: {
      type: String,
      default: null,
      index: true,
    },
    // `schema.index({ status: 1 })` is declared below; `index: true` here would create
    // the same single-field index twice and emit the "Duplicate schema index" warning.
    status: {
      type: String,
      // 'suppressed': the recipient's notification preferences blocked this email, so it was
      // never handed to SMTP. Logged rather than dropped silently — "I never got the invite"
      // has to be answerable from the audit trail, not from guesswork.
      enum: ['pending', 'sent', 'failed', 'suppressed'],
      default: 'pending',
    },
    error: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index({ to: 1, createdAt: -1 });
emailLogSchema.index({ status: 1 });

const EmailLog = mongoose.model('EmailLog', emailLogSchema);
export default EmailLog;
