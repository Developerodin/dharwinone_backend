import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const emailAccountSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['gmail', 'outlook', 'imap'],
      required: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    accessToken: {
      type: String,
      required: true,
      private: true,
    },
    refreshToken: {
      type: String,
      default: null,
      private: true,
    },
    tokenExpiry: {
      type: Date,
      default: null,
    },
    // OAuth client_id (Azure App Registration) that issued this account's tokens.
    // Outlook refresh tokens are bound to their issuing client, so refresh must reuse it.
    // null for legacy accounts connected before this field existed (refresh self-heals it).
    oauthClientId: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'revoked', 'error'],
      default: 'active',
    },
    imapConfig: {
      host: String,
      port: Number,
      secure: Boolean,
    },
    smtpConfig: {
      host: String,
      port: Number,
      secure: Boolean,
    },
  },
  {
    timestamps: true,
  }
);

emailAccountSchema.plugin(toJSON);

emailAccountSchema.index({ user: 1, provider: 1, email: 1 }, { unique: true });
emailAccountSchema.index({ user: 1, status: 1 });

/**
 * @typedef EmailAccount
 */
const EmailAccount = mongoose.model('EmailAccount', emailAccountSchema);

export default EmailAccount;
