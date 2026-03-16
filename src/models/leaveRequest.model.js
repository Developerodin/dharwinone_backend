import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const leaveRequestSchema = mongoose.Schema(
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
    dates: {
      type: [Date],
      required: true,
      validate: {
        validator: function (v) {
          return v && v.length > 0;
        },
        message: 'At least one date is required',
      },
    },
    leaveType: {
      type: String,
      enum: ['casual', 'sick', 'unpaid'],
      required: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    adminComment: {
      type: String,
      trim: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ student: 1, status: 1 });
leaveRequestSchema.index({ student: 1, createdAt: -1 });
leaveRequestSchema.index({ status: 1, createdAt: -1 });
leaveRequestSchema.index({ studentEmail: 1, status: 1 });

leaveRequestSchema.plugin(toJSON);
leaveRequestSchema.plugin(paginate);

// Restore createdAt/updatedAt in API response (toJSON plugin removes them by default)
const leaveRequestToJSON = leaveRequestSchema.options.toJSON?.transform;
leaveRequestSchema.options.toJSON = leaveRequestSchema.options.toJSON || {};
leaveRequestSchema.options.toJSON.transform = function (doc, ret, options) {
  if (leaveRequestToJSON) leaveRequestToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);

export default LeaveRequest;
