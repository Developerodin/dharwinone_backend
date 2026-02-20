import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const recordingSchema = mongoose.Schema(
  {
    /** Meeting ID (same as roomName in LiveKit) */
    meetingId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    /** LiveKit egress ID */
    egressId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    /** S3 (or MinIO) object key for the recording file */
    filePath: {
      type: String,
      required: true,
      trim: true,
    },
    /** recording | completed */
    status: {
      type: String,
      enum: ['recording', 'completed'],
      default: 'recording',
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

recordingSchema.plugin(toJSON);

const Recording = mongoose.model('Recording', recordingSchema);
export default Recording;
