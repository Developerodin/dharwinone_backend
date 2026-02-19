import mongoose from 'mongoose';
import crypto from 'crypto';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const meetingSchema = mongoose.Schema(
  {
    // Unique ID for public URL and LiveKit room name (e.g. meeting_0a33c0436e6c302d)
    meetingId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // LiveKit room name (same as meetingId). Kept for legacy index roomName_1.
    roomName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // --- Old-project fields ---
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    scheduledAt: {
      type: Date,
      required: true,
    },
    timezone: {
      type: String,
      trim: true,
      default: 'Asia/Calcutta',
    },
    durationMinutes: {
      type: Number,
      required: true,
      default: 60,
    },
    maxParticipants: {
      type: Number,
      default: 10,
    },
    allowGuestJoin: {
      type: Boolean,
      default: true,
    },
    requireApproval: {
      type: Boolean,
      default: false,
    },
    hosts: [
      {
        nameOrRole: { type: String, trim: true, default: '' },
        email: { type: String, required: true, trim: true },
      },
    ],
    emailInvites: [
      {
        type: String,
        trim: true,
      },
    ],
    // --- Current Schedule Interview fields ---
    jobPosition: {
      type: String,
      trim: true,
    },
    interviewType: {
      type: String,
      enum: ['Video', 'In-Person', 'Phone'],
      default: 'Video',
    },
    candidate: {
      id: { type: String, trim: true }, // MongoDB ObjectId or external/mock id (e.g. "1")
      name: { type: String, trim: true },
      email: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    recruiter: {
      id: { type: String, trim: true }, // MongoDB ObjectId or external/mock id (e.g. "1")
      name: { type: String, trim: true },
      email: { type: String, trim: true },
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    // --- System ---
    status: {
      type: String,
      enum: ['scheduled', 'ended', 'cancelled'],
      default: 'scheduled',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

meetingSchema.plugin(toJSON);
meetingSchema.plugin(paginate);

/**
 * Generate unique meetingId
 * @returns {string}
 */
meetingSchema.statics.generateMeetingId = async function () {
  let id;
  let exists = true;
  while (exists) {
    id = `meeting_${crypto.randomBytes(8).toString('hex')}`;
    const found = await this.findOne({ meetingId: id });
    exists = !!found;
  }
  return id;
};

const Meeting = mongoose.model('Meeting', meetingSchema);
export default Meeting;
