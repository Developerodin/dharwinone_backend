import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const attendanceSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
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
      enum: ['Present', 'Absent', 'Holiday', 'Leave'],
      default: 'Present',
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

attendanceSchema.pre('save', function (next) {
  if (this.punchOut != null && this.punchIn != null && (this.duration == null || this.duration === undefined)) {
    this.duration = this.punchOut.getTime() - this.punchIn.getTime();
  }
  next();
});

attendanceSchema.plugin(toJSON);

const Attendance = mongoose.model('Attendance', attendanceSchema);

export default Attendance;
