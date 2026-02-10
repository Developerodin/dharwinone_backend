import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const mentorSchema = mongoose.Schema(
  {
    // Reference to User model (required, unique - one mentor profile per user)
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    // Personal Information
    phone: {
      type: String,
      trim: true,
    },
    dateOfBirth: {
      type: Date,
    },
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
    },
    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true },
    },
    // Expertise/Specialization
    expertise: [
      {
        area: { type: String, trim: true }, // e.g., "Software Development", "Data Science"
        level: { type: String, trim: true }, // e.g., "Expert", "Advanced", "Intermediate"
        yearsOfExperience: { type: Number },
        description: { type: String, trim: true },
      },
    ],
    // Professional Experience
    experience: [
      {
        title: { type: String, trim: true },
        company: { type: String, trim: true },
        location: { type: String, trim: true },
        startDate: { type: Date },
        endDate: { type: Date },
        isCurrent: { type: Boolean, default: false },
        description: { type: String, trim: true },
      },
    ],
    // Certifications
    certifications: [
      {
        name: { type: String, required: true, trim: true },
        issuer: { type: String, required: true, trim: true },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        credentialId: { type: String, trim: true },
        credentialUrl: { type: String, trim: true },
      },
    ],
    // Skills
    skills: {
      type: [String],
      default: [],
    },
    // Profile Image
    profileImageUrl: {
      type: String,
      default: null,
    },
    // Additional Info
    bio: {
      type: String,
      trim: true,
    },
    // Status
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

mentorSchema.plugin(toJSON);
mentorSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response
const originalToJSON = mentorSchema.options.toJSON?.transform;
mentorSchema.options.toJSON = mentorSchema.options.toJSON || {};
mentorSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if user already has a mentor profile
 * @param {ObjectId} userId
 * @returns {Promise<boolean>}
 */
mentorSchema.statics.isMentorProfileExists = async function (userId) {
  const mentor = await this.findOne({ user: userId });
  return !!mentor;
};

/**
 * @typedef Mentor
 */
const Mentor = mongoose.model('Mentor', mentorSchema);

export default Mentor;
