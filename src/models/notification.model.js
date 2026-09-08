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
        'sop',
        'support_ticket',
        'dev_ticket',
        'general',
        'chat_message',
        'joining_reminder',
        'placement_update',
        'onboarding_reminder',
        'system',
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
    triggeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    relatedEntity: {
      type: { type: String, default: null },
      /**
       * Free-form entity id, stored as a string. NOT an ObjectId: meeting notifications
       * reference the LiveKit room id (`meeting_<hex>`), which is what
       * `utils/notificationLink.js` turns into `/join/room?room=<id>`. An ObjectId path
       * here threw a CastError on every meeting notification and — because notify()
       * queues the email after this write — took the reminder email down with it.
       * Documents that stored a BSON ObjectId before this change hydrate to their hex
       * string, which is what every consumer already does with `String(id)`.
       */
      id: {
        type: String,
        default: null,
      },
      _id: false,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });
notificationSchema.index({ user: 1, type: 1, createdAt: -1 });
notificationSchema.plugin(paginate);

const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;
