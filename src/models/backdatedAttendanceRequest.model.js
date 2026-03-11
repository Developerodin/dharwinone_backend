import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const attendanceEntrySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, index: true },
    punchIn: { type: Date, required: true },
    punchOut: { type: Date, default: null },
    timezone: { type: String, trim: true, default: 'UTC' },
  },
  { _id: false }
);

const backdatedAttendanceRequestSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    studentEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    attendanceEntries: {
      type: [attendanceEntrySchema],
      required: true,
      validate: {
        validator: function (v) {
          return v && v.length > 0;
        },
        message: 'At least one attendance entry is required',
      },
    },
    notes: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    adminComment: { type: String, trim: true },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

backdatedAttendanceRequestSchema.index({ student: 1, status: 1 });
backdatedAttendanceRequestSchema.index({ student: 1, createdAt: -1 });
backdatedAttendanceRequestSchema.index({ status: 1, createdAt: -1 });
backdatedAttendanceRequestSchema.index({ studentEmail: 1, status: 1 });

backdatedAttendanceRequestSchema.plugin(toJSON);
backdatedAttendanceRequestSchema.plugin(paginate);

// Preserve createdAt/updatedAt in API response (toJSON plugin strips them by default)
const originalToJSON = backdatedAttendanceRequestSchema.options.toJSON?.transform;
backdatedAttendanceRequestSchema.options.toJSON = backdatedAttendanceRequestSchema.options.toJSON || {};
backdatedAttendanceRequestSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  if (doc.createdAt != null) ret.createdAt = doc.createdAt;
  if (doc.updatedAt != null) ret.updatedAt = doc.updatedAt;
  return ret;
};

const BackdatedAttendanceRequest = mongoose.model('BackdatedAttendanceRequest', backdatedAttendanceRequestSchema);

export default BackdatedAttendanceRequest;
