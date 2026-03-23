import mongoose from 'mongoose';
import paginate from './plugins/paginate.plugin.js';

const notificationSchema = mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'leave',
        'task',
        'offer',
        'meeting',
        'meeting_reminder',
        'course',
        'certificate',
        'job_application',
        'project',
        'account',
        'recruiter',
        'assignment',
        'general',
      ],
      default: 'general',
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    link: {
      type: String,
      default: null,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });
notificationSchema.plugin(paginate);

const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
