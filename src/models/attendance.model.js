import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import { clampSessionDurationMs } from '../utils/attendanceDuration.js';

/**
 * The only statuses an Attendance row may carry. Exported so analytics can tell
 * a valid state from a row that predates the field: rows written before `status`
 * existed have NO status key at all, and must not be silently counted as
 * Present. See scripts/backfill-attendance-status.js for the cleanup path.
 */
export const ATTENDANCE_STATUSES = ['Present', 'Absent', 'Holiday', 'Leave'];

const attendanceSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: false,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    studentEmail: {
      type: String,
      trim: true,
      index: true,
    },
    studentName: {
      type: String,
      trim: true,
      default: '',
    },
    date: {
      type: Date,
      required: true,
      index: true,
    }, // UTC midnight for attendance day
    day: {
      type: String,
      trim: true,
    }, // Monday, Tuesday, etc.
    punchIn: {
      type: Date,
      required: true,
    },
    punchOut: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
    }, // milliseconds; set in pre-save when punchOut exists
    timezone: {
      type: String,
      trim: true,
      default: 'UTC',
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ATTENDANCE_STATUSES,
      default: 'Present',
    },
    /** When status is 'Leave', type of leave: casual, sick, or unpaid */
    leaveType: {
      type: String,
      enum: ['casual', 'sick', 'unpaid'],
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

attendanceSchema.index({ student: 1, date: 1 });
attendanceSchema.index({ student: 1, punchOut: 1 });
attendanceSchema.index({ user: 1, date: 1 });
attendanceSchema.index({ user: 1, punchOut: 1 });
attendanceSchema.index({ isActive: 1, date: -1, punchOut: 1 });

attendanceSchema.pre('save', function (next) {
  const hasStudent = this.student != null;
  const hasUser = this.user != null;
  if (hasStudent === hasUser) {
    return next(new Error('Exactly one of student or user must be set'));
  }
  if (this.punchOut != null && this.punchIn != null) {
    const raw = this.punchOut.getTime() - this.punchIn.getTime();
    if (this.duration == null || this.duration === undefined) {
      this.duration = raw > 0 ? clampSessionDurationMs(raw) : this.duration;
    } else if (this.duration > 0) {
      this.duration = clampSessionDurationMs(this.duration);
    }
  }
  next();
});

attendanceSchema.plugin(toJSON);

const Attendance = mongoose.model('Attendance', attendanceSchema);

export default Attendance;
