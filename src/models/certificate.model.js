import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';
import crypto from 'crypto';

const certificateSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingModule',
      required: true,
      index: true,
    },
    certificateId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // Certificate details
    studentName: {
      type: String,
      required: true,
    },
    courseName: {
      type: String,
      required: true,
    },
    completionDate: {
      type: Date,
      required: true,
    },
    finalScore: {
      type: Number, // Average quiz score or overall score
      default: 0,
      min: 0,
      max: 100,
    },
    // Certificate file/storage
    certificateUrl: {
      type: String, // URL to PDF/image certificate
      trim: true,
    },
    certificateKey: {
      type: String, // Storage key if using file storage
      trim: true,
    },
    // Verification
    verificationCode: {
      type: String, // Unique code for certificate verification
      unique: true,
      trim: true,
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Generate unique certificate ID and verification code before saving
certificateSchema.pre('save', async function (next) {
  if (!this.certificateId) {
    // Generate certificate ID: CERT-{timestamp}-{random}
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    this.certificateId = `CERT-${timestamp}-${random}`;
  }
  if (!this.verificationCode) {
    // Generate verification code: 8-character alphanumeric
    this.verificationCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  }
  next();
});

// Indexes
certificateSchema.index({ student: 1, module: 1 }, { unique: true });
certificateSchema.index({ certificateId: 1 }, { unique: true });
certificateSchema.index({ verificationCode: 1 }, { unique: true });

certificateSchema.plugin(toJSON);
certificateSchema.plugin(paginate);

// Include createdAt and updatedAt in API response
const originalToJSON = certificateSchema.options.toJSON?.transform;
certificateSchema.options.toJSON = certificateSchema.options.toJSON || {};
certificateSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * @typedef Certificate
 */
const Certificate = mongoose.model('Certificate', certificateSchema);

export default Certificate;
