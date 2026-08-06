import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const attachmentSubSchema = {
  key: { type: String, required: true },
  url: { type: String, required: true },
  originalName: { type: String, required: true },
  size: { type: Number, required: true },
  mimeType: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
};

const activityEntrySchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    field: { type: String },
    from: { type: String },
    to: { type: String },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

const commentSchema = new mongoose.Schema(
  {
    content: { type: String, required: true, trim: true },
    commentedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    isAdminComment: { type: Boolean, default: false },
    attachments: { type: [attachmentSubSchema], default: [] },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    reactions: [
      {
        emoji: { type: String, required: true },
        users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      },
    ],
  },
  { timestamps: true }
);

const LABELS = ['regression', 'needs-repro', 'good-first-bug', 'performance', 'security', 'ui'];
const CATEGORIES = ['Bug', 'New Feature', 'Improvement'];
/** Product surface the ticket targets — UI picks this; backend maps it to assignedTo. */
const PLATFORMS = ['web', 'mobile'];
const PLATFORM_ASSIGNEE_EMAILS = {
  web: 'prakhar@theodin.in',
  mobile: 'vijay@theodin.in',
};
const DEFAULT_TESTER_EMAIL = 'harshbansal.it26@gmail.com';
const PLATFORM_LABELS = { web: 'Web', mobile: 'Mobile App' };
const LINK_RELS = ['blocks', 'blocked-by', 'duplicate-of', 'relates-to'];

const devTicketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    stepsToReproduce: { type: String, trim: true },
    pageUrl: { type: String, trim: true },
    status: {
      type: String,
      enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
      default: 'Open',
    },
    priority: {
      type: String,
      enum: ['Low', 'Medium', 'High', 'Urgent'],
      default: 'Medium',
    },
    severity: {
      type: String,
      enum: ['Minor', 'Major', 'Critical', 'Blocker'],
      default: 'Major',
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'Bug',
    },
    platform: {
      type: String,
      enum: PLATFORMS,
      default: 'web',
      index: true,
    },
    module: { type: String, trim: true, default: '' },
    environment: {
      type: String,
      enum: ['Staging', 'Production'],
      default: 'Staging',
    },
    labels: [{ type: String, enum: LABELS }],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    testedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    links: [
      {
        rel: { type: String, enum: LINK_RELS, required: true },
        ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'DevTicket', required: true },
      },
    ],
    git: {
      branch: { type: String, trim: true },
      pullRequests: [{ number: Number, title: String, url: String }],
      commits: [{ sha: String, message: String, url: String }],
    },
    comments: { type: [commentSchema], default: [] },
    attachments: { type: [attachmentSubSchema], default: [] },
    activityLog: { type: [activityEntrySchema], default: [] },
    reopenCount: { type: Number, default: 0 },
    reopenedAt: { type: Date },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

devTicketSchema.index({ status: 1, createdAt: -1 });
devTicketSchema.index({ priority: 1, createdAt: -1 });
devTicketSchema.index({ severity: 1, createdAt: -1 });
devTicketSchema.index({ labels: 1 });
devTicketSchema.index({ title: 'text', description: 'text' });

devTicketSchema.pre('save', async function (next) {
  if (this.isNew && !this.ticketId) {
    const crypto = await import('crypto');
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    this.ticketId = `DEV-${timestamp}-${random}`;
  }
  next();
});

devTicketSchema.methods.addComment = function (content, userId, isAdmin = false, attachments = [], mentions = []) {
  this.comments.push({
    content,
    commentedBy: userId,
    isAdminComment: isAdmin,
    attachments,
    mentions,
    reactions: [],
  });
  return this.save();
};

devTicketSchema.methods.updateStatus = function (status, userId) {
  this.status = status;
  if (status === 'Resolved') {
    this.resolvedAt = new Date();
    this.resolvedBy = userId;
  } else if (status === 'Closed') {
    this.closedAt = new Date();
    this.closedBy = userId;
  }
  return this.save();
};

devTicketSchema.methods.logActivity = function (action, performedBy, field, from, to) {
  this.activityLog.push({ action, performedBy, field, from, to });
};

devTicketSchema.plugin(toJSON);
devTicketSchema.plugin(paginate);

export {
  LABELS,
  LINK_RELS,
  CATEGORIES,
  PLATFORMS,
  PLATFORM_ASSIGNEE_EMAILS,
  DEFAULT_TESTER_EMAIL,
  PLATFORM_LABELS,
};
const DevTicket = mongoose.model('DevTicket', devTicketSchema);
export default DevTicket;
