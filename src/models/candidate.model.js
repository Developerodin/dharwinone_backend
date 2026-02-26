import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const qualificationSchema = new mongoose.Schema(
  {
    degree: { type: String, required: true, trim: true },
    institute: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    startYear: { type: Number },
    endYear: { type: Number },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const experienceSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    currentlyWorking: { type: Boolean, default: false },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const DOCUMENT_TYPES = ['Resume', 'Aadhar', 'PAN', 'Bank', 'Passport', 'Other'];

const documentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DOCUMENT_TYPES, default: 'Other', trim: true },
    label: { type: String, trim: true },
    url: { type: String, trim: true },
    key: { type: String, trim: true },
    originalName: { type: String, trim: true },
    size: { type: Number },
    mimeType: { type: String, trim: true },
    status: { type: Number, default: 0 },
    adminNotes: { type: String, trim: true },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const skillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], default: 'Beginner' },
    category: { type: String, trim: true },
  },
  { _id: false }
);

const socialLinkSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const salarySlipSchema = new mongoose.Schema(
  {
    month: { type: String, trim: true },
    year: { type: Number, min: 1900, max: 2100 },
    documentUrl: { type: String, trim: true },
    key: { type: String, trim: true },
    originalName: { type: String, trim: true },
    size: { type: Number },
    mimeType: { type: String, trim: true },
  },
  { _id: false }
);

const candidateSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeId: { type: String, trim: true, unique: true, sparse: true, index: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    phoneNumber: { type: String, required: true, trim: true },
    profilePicture: {
      url: { type: String, trim: true },
      key: { type: String, trim: true },
      originalName: { type: String, trim: true },
      size: { type: Number },
      mimeType: { type: String, trim: true },
    },
    shortBio: { type: String, trim: true },
    sevisId: { type: String, trim: true },
    ead: { type: String, trim: true },
    visaType: { type: String, trim: true },
    customVisaType: { type: String, trim: true },
    countryCode: { type: String, trim: true },
    degree: { type: String, trim: true },
    supervisorName: { type: String, trim: true },
    supervisorContact: { type: String, trim: true },
    supervisorCountryCode: { type: String, trim: true },
    salaryRange: { type: String, trim: true },
    address: {
      streetAddress: { type: String, trim: true },
      streetAddress2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      zipCode: { type: String, trim: true },
      country: { type: String, trim: true },
    },
    qualifications: { type: [qualificationSchema], default: [] },
    experiences: { type: [experienceSchema], default: [] },
    documents: { type: [documentSchema], default: [] },
    skills: { type: [skillSchema], default: [] },
    socialLinks: { type: [socialLinkSchema], default: [] },
    salarySlips: { type: [salarySlipSchema], default: [] },
    isProfileCompleted: { type: Number, default: 0, min: 0, max: 100 },
    isCompleted: { type: Boolean, default: false },
    recruiterNotes: [
      {
        note: { type: String, trim: true, required: true },
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    recruiterFeedback: { type: String, trim: true },
    recruiterRating: { type: Number, min: 1, max: 5 },
    assignedRecruiter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    joiningDate: { type: Date, index: true },
    resignDate: { type: Date, index: true },
    isActive: { type: Boolean, default: true, index: true },
    weekOff: {
      type: [String],
      enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      default: [],
      index: true,
    },
    holidays: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Holiday' }],
      default: [],
      index: true,
    },
    leaves: [
      {
        date: { type: Date, required: true, index: true },
        leaveType: { type: String, enum: ['casual', 'sick', 'unpaid'], required: true },
        notes: { type: String, trim: true },
        assignedAt: { type: Date, default: Date.now },
      },
    ],
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null, index: true },
    department: { type: String, trim: true, index: true },
    designation: { type: String, trim: true, index: true },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

candidateSchema.pre('save', async function (next) {
  if (this.isNew && (!this.employeeId || this.employeeId.trim() === '')) {
    try {
      const candidatesWithIds = await this.constructor
        .find({ employeeId: { $exists: true, $ne: null, $regex: /^DBS\d+$/i } }, { employeeId: 1 })
        .lean();
      let maxNumber = 0;
      candidatesWithIds.forEach((candidate) => {
        if (candidate.employeeId) {
          const match = candidate.employeeId.match(/^DBS(\d+)$/i);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
      });
      this.employeeId = `DBS${maxNumber + 1}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

candidateSchema.pre('save', function (next) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (this.resignDate) {
    const resignDate = new Date(this.resignDate);
    resignDate.setHours(0, 0, 0, 0);
    this.isActive = resignDate > now;
  } else if (this.isModified('resignDate') && !this.resignDate) {
    this.isActive = true;
  }
  next();
});

candidateSchema.plugin(toJSON);
candidateSchema.plugin(paginate);

const Candidate = mongoose.model('Candidate', candidateSchema);
export default Candidate;
