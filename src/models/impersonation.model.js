import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

/**
 * Audit record for administrator impersonation.
 * Records who impersonated whom, when it started and ended.
 * adminRefreshToken is stored so the admin can be restored when they stop impersonation.
 * In production, consider encrypting adminRefreshToken at rest.
 */
const impersonationSchema = mongoose.Schema(
  {
    adminUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    impersonatedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    adminRefreshToken: {
      type: String,
      required: true,
      private: true,
    },
  },
  {
    timestamps: true,
  }
);

impersonationSchema.plugin(toJSON);

const Impersonation = mongoose.model('Impersonation', impersonationSchema);

export default Impersonation;
