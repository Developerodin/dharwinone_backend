import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Placement - created when an offer is Accepted. Tracks the placed candidate.
 */
const placementSchema = new mongoose.Schema(
  {
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Offer',
      required: true,
      unique: true,
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      index: true,
    },
    joiningDate: {
      type: Date,
      required: true,
      index: true,
    },
    employeeId: { type: String, trim: true, index: true },
    status: {
      type: String,
      enum: ['Pending', 'Joined', 'Deferred', 'Cancelled'],
      default: 'Pending',
      index: true,
    },
    preBoardingStatus: {
      type: String,
      enum: ['Pending', 'In Progress', 'Completed'],
      default: 'Pending',
      index: true,
    },
    backgroundVerification: {
      status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Verified'], default: 'Pending' },
      requestedAt: { type: Date },
      completedAt: { type: Date },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      agency: { type: String, trim: true },
      notes: { type: String, trim: true },
    },
    assetAllocation: [
      {
        name: { type: String, required: true, trim: true },
        type: { type: String, trim: true },
        serialNumber: { type: String, trim: true },
        allocatedAt: { type: Date, default: Date.now },
        notes: { type: String, trim: true },
      },
    ],
    itAccess: [
      {
        system: { type: String, required: true, trim: true },
        accessLevel: { type: String, trim: true },
        provisionedAt: { type: Date, default: Date.now },
        notes: { type: String, trim: true },
      },
    ],
    notes: { type: String, trim: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** When status becomes Joined (operational) */
    joinedAt: { type: Date, default: null, index: true },
    /** User who last set placement status to Deferred */
    deferredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    deferredAt: { type: Date, default: null },
    /** User who set placement status to Cancelled (terminal) */
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    cancelledAt: { type: Date, default: null },
    /** Skip candidate emails for T-1 and Joined handoff when true */
    suppressCandidateNotifications: { type: Boolean, default: false },
    /** Checklist items; preBoardingStatus is synced from these when array non-empty */
    preBoardingTasks: {
      type: [
        {
          _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
          title: { type: String, trim: true, required: true },
          required: { type: Boolean, default: true },
          done: { type: Boolean, default: false },
          doneAt: { type: Date, default: null },
          order: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    onboardingTasks: {
      type: [
        {
          _id: { type: mongoose.Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
          title: { type: String, trim: true, required: true },
          required: { type: Boolean, default: true },
          done: { type: Boolean, default: false },
          doneAt: { type: Date, default: null },
          order: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    /** Deduplication for joining reminder scheduler */
    reminderSentAt: {
      t7: { type: Date, default: null },
      t1Recruiter: { type: Date, default: null },
      t1Candidate: { type: Date, default: null },
      /** agentUserId (hex) -> last sent (ISO) stored as Mixed map */
      t1ByAgent: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    },
    trainingModuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainingModule', default: null },
    trainingAssignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

placementSchema.index({ status: 1, createdAt: -1 });

placementSchema.plugin(toJSON);
placementSchema.plugin(paginate);

const Placement = mongoose.model('Placement', placementSchema);
export default Placement;
