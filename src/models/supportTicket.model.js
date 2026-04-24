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
    isInternal: { type: Boolean, default: false },
    attachments: { type: [attachmentSubSchema], default: [] },
  },
  { timestamps: true }
);

const SLA_TARGETS = {
  Urgent: { firstResponse: 1 * 60, resolution: 4 * 60 },
  High: { firstResponse: 4 * 60, resolution: 24 * 60 },
  Medium: { firstResponse: 8 * 60, resolution: 48 * 60 },
  Low: { firstResponse: 24 * 60, resolution: 72 * 60 },
};

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, unique: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
      default: 'Open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['Low', 'Medium', 'High', 'Urgent'],
      default: 'Medium',
      index: true,
    },
    category: { type: String, trim: true, default: 'General' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      index: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    comments: { type: [commentSchema], default: [] },
    attachments: { type: [attachmentSubSchema], default: [] },

    // SLA tracking
    firstResponseAt: { type: Date },
    slaBreached: { type: Boolean, default: false },

    // Activity / audit log
    activityLog: { type: [activityEntrySchema], default: [] },

    // Lifecycle timestamps
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Indexes
supportTicketSchema.index({ createdBy: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ priority: 1, createdAt: -1 });
supportTicketSchema.index({ ticketId: 1 });
supportTicketSchema.index({ title: 'text', description: 'text' });

// Pre-save: generate unique ticket ID
supportTicketSchema.pre('save', async function (next) {
  if (this.isNew && !this.ticketId) {
    const crypto = await import('crypto');
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    this.ticketId = `TKT-${timestamp}-${random}`;
  }
  next();
});

supportTicketSchema.methods.addComment = function (content, userId, isAdmin = false, attachments = [], isInternal = false) {
  this.comments.push({
    content,
    commentedBy: userId,
    isAdminComment: isAdmin,
    isInternal,
    attachments,
  });
  return this.save();
};

supportTicketSchema.methods.updateStatus = function (status, userId) {
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

supportTicketSchema.methods.logActivity = function (action, performedBy, field, from, to) {
  this.activityLog.push({ action, performedBy, field, from, to });
};

supportTicketSchema.methods.getSlaStatus = function () {
  const targets = SLA_TARGETS[this.priority] || SLA_TARGETS.Medium;
  const now = Date.now();
  const created = new Date(this.createdAt).getTime();
  const elapsedMin = (now - created) / 60000;

  const firstResponseMet = !!this.firstResponseAt;
  const firstResponseElapsed = firstResponseMet
    ? (new Date(this.firstResponseAt).getTime() - created) / 60000
    : elapsedMin;

  const resolved = this.status === 'Resolved' || this.status === 'Closed';
  const resolutionElapsed = resolved && this.resolvedAt
    ? (new Date(this.resolvedAt).getTime() - created) / 60000
    : elapsedMin;

  return {
    firstResponse: {
      targetMin: targets.firstResponse,
      elapsedMin: Math.round(firstResponseElapsed),
      met: firstResponseMet,
      breached: firstResponseElapsed > targets.firstResponse,
    },
    resolution: {
      targetMin: targets.resolution,
      elapsedMin: Math.round(resolutionElapsed),
      met: resolved,
      breached: resolutionElapsed > targets.resolution,
    },
  };
};

supportTicketSchema.plugin(toJSON);
supportTicketSchema.plugin(paginate);

export { SLA_TARGETS };
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
export default SupportTicket;
