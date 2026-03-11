import mongoose from 'mongoose';
import validator from 'validator';
import bcrypt from 'bcryptjs';
// import { toJSON, paginate } from './plugins.js';
import { roles } from '../config/roles.js';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const userSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      validate(value) {
        if (!validator.isEmail(value)) {
          throw new Error('Invalid email');
        }
      },
    },
    username: {
      type: String,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      trim: true,
      minlength: 8,
      validate(value) {
        if (!value.match(/\d/) || !value.match(/[a-zA-Z]/)) {
          throw new Error('Password must contain at least one letter and one number');
        }
      },
      private: true, // used by the toJSON plugin
    },
    role: {
      type: String,
      enum: roles,
      default: 'user',
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    roleIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Role',
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'pending', 'disabled', 'deleted'],
      default: 'active',
    },
    phoneNumber: { type: String, trim: true },
    countryCode: { type: String, trim: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    education: { type: String, trim: true },
    domain: { type: [String], default: [] },
    location: { type: String, trim: true },
    profileSummary: { type: String, trim: true },
    profilePicture: {
      url: { type: String, trim: true },
      key: { type: String, trim: true },
      originalName: { type: String, trim: true },
      size: { type: Number },
      mimeType: { type: String, trim: true },
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    notificationPreferences: {
      leaveUpdates: { type: Boolean, default: true },
      taskAssignments: { type: Boolean, default: true },
      applicationUpdates: { type: Boolean, default: true },
      offerUpdates: { type: Boolean, default: true },
      meetingInvitations: { type: Boolean, default: true },
      meetingReminders: { type: Boolean, default: true },
      certificates: { type: Boolean, default: true },
      courseUpdates: { type: Boolean, default: true },
      recruiterUpdates: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
  }
);

// add plugin that converts mongoose to json
userSchema.plugin(toJSON);
userSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response for users
const originalUserToJSON = userSchema.options.toJSON?.transform;
userSchema.options.toJSON = userSchema.options.toJSON || {};
userSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalUserToJSON) originalUserToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if email is taken
 * @param {string} email - The user's email
 * @param {ObjectId} [excludeUserId] - The id of the user to be excluded
 * @returns {Promise<boolean>}
 */
userSchema.statics.isEmailTaken = async function (email, excludeUserId) {
  const user = await this.findOne({ email, _id: { $ne: excludeUserId } });
  return !!user;
};

/**
 * Check if password matches the user's password
 * @param {string} password
 * @returns {Promise<boolean>}
 */
userSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  return bcrypt.compare(password, user.password);
};

userSchema.pre('save', async function (next) {
  const user = this;
  // Satisfy unique index on username: default to email so we never store null (multiple nulls violate unique)
  if (!user.username) {
    user.username = user.email;
  }
  if (user.isModified('password')) {
    user.password = await bcrypt.hash(user.password, 8);
  }
  // Normalize domain: ensure array of strings (backward compat with string)
  if (user.domain != null) {
    if (typeof user.domain === 'string') {
      user.domain = user.domain.trim() ? [user.domain.trim()] : [];
    } else if (Array.isArray(user.domain)) {
      user.domain = user.domain.map((d) => String(d).trim()).filter(Boolean);
    } else {
      user.domain = [];
    }
  }
  next();
});

/**
 * @typedef User
 */
const User = mongoose.model('User', userSchema);

export default User;

