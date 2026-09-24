import mongoose from 'mongoose';
import { toJSON } from './plugins/index.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const windowSchema = new mongoose.Schema(
  {
    start: { type: String, required: true, match: HHMM },
    end: { type: String, required: true, match: HHMM },
  },
  { _id: false }
);

const interviewerAvailabilitySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    timezone: { type: String, required: true, default: 'Asia/Kolkata', trim: true },
    bufferMinutes: { type: Number, default: 15, min: 0, max: 120 },
    weekly: [
      new mongoose.Schema(
        {
          day: { type: Number, required: true, min: 0, max: 6 }, // 0 = Sunday
          start: { type: String, required: true, match: HHMM },
          end: { type: String, required: true, match: HHMM },
        },
        { _id: false }
      ),
    ],
    overrides: [
      new mongoose.Schema(
        {
          date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
          blocked: { type: Boolean, default: false },
          windows: [windowSchema],
        },
        { _id: false }
      ),
    ],
  },
  { timestamps: true }
);

interviewerAvailabilitySchema.plugin(toJSON);

const InterviewerAvailability = mongoose.model('InterviewerAvailability', interviewerAvailabilitySchema);

export default InterviewerAvailability;
