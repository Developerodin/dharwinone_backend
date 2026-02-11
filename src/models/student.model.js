import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const studentSchema = mongoose.Schema(
  {
    // Reference to User model (required, unique - one student profile per user)
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
    // Education
    education: [
      {
        degree: { type: String, trim: true },
        institution: { type: String, trim: true },
        fieldOfStudy: { type: String, trim: true },
        startDate: { type: Date },
        endDate: { type: Date },
        isCurrent: { type: Boolean, default: false },
        description: { type: String, trim: true },
      },
    ],
    // Work Experience
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
    // Skills
    skills: {
      type: [String],
      default: [],
    },
    // Documents
    documents: [
      {
        name: { type: String, required: true, trim: true },
        type: { type: String, required: true, trim: true },
        fileUrl: { type: String, trim: true },
        fileKey: { type: String, trim: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
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

studentSchema.plugin(toJSON);
studentSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response
const originalToJSON = studentSchema.options.toJSON?.transform;
studentSchema.options.toJSON = studentSchema.options.toJSON || {};
studentSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if user already has a student profile
 * @param {ObjectId} userId
 * @returns {Promise<boolean>}
 */
studentSchema.statics.isStudentProfileExists = async function (userId) {
  const student = await this.findOne({ user: userId });
  return !!student;
};

/**
 * @typedef Student
 */
const Student = mongoose.model('Student', studentSchema);

export default Student;
