import httpStatus from 'http-status';
import SupportTicket from '../models/supportTicket.model.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import ApiError from '../utils/ApiError.js';
import { uploadMultipleFilesToS3 } from './upload.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { notify } from './notification.service.js';
import logger from '../config/logger.js';
import Role from '../models/role.model.js';
import { userIsAdmin, userIsAgent } from '../utils/roleHelpers.js';

const ATTACHMENT_PRESIGN_TTL_SEC = 7 * 24 * 3600;
const TICKET_LINK = '/support-tickets';
const POPULATE_PATHS = [
  { path: 'createdBy', select: 'name email' },
  { path: 'candidate', select: 'fullName email' },
  { path: 'assignedTo', select: 'name email' },
  { path: 'resolvedBy', select: 'name email' },
  { path: 'closedBy', select: 'name email' },
  { path: 'comments.commentedBy', select: 'name email' },
  { path: 'activityLog.performedBy', select: 'name email' },
];

// ──────────────────────────── helpers ────────────────────────────

const refreshAttachmentUrls = async (ticketObj) => {
  if (!ticketObj) return ticketObj;
  const refresh = async (att) => {
    if (att.key) {
      try { att.url = await generatePresignedDownloadUrl(att.key, ATTACHMENT_PRESIGN_TTL_SEC); }
      catch (e) { logger.warn(`Presign fail (key=${att.key}): ${e?.message}`); }
    }
  };
  if (ticketObj.attachments?.length) await Promise.all(ticketObj.attachments.map(refresh));
  if (ticketObj.comments?.length) {
    for (const c of ticketObj.comments) {
      if (c.attachments?.length) await Promise.all(c.attachments.map(refresh));
    }
  }
  return ticketObj;
};

const populateCommenters = async (comments) => {
  if (!comments?.length) return;
  const needIds = new Set();
  for (const c of comments) {
    if (!c.commentedBy) continue;
    if (typeof c.commentedBy === 'string') { needIds.add(c.commentedBy); continue; }
    if (typeof c.commentedBy === 'object' && !c.commentedBy.name) {
      needIds.add(c.commentedBy._id?.toString() || c.commentedBy.toString());
    }
  }
  if (!needIds.size) {
    for (const c of comments) {
      if (c.commentedBy?._id) { c.commentedBy.id = c.commentedBy._id.toString(); delete c.commentedBy._id; }
    }
    return;
  }
  const users = await User.find({ _id: { $in: [...needIds] } }).select('name email').lean();
  const map = Object.fromEntries(users.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email }]));
  for (const c of comments) {
    if (!c.commentedBy) continue;
    const cid = typeof c.commentedBy === 'string' ? c.commentedBy : (c.commentedBy._id?.toString() || c.commentedBy.toString());
    if (map[cid]) c.commentedBy = map[cid];
    else if (c.commentedBy?._id) { c.commentedBy.id = c.commentedBy._id.toString(); delete c.commentedBy._id; }
  }
};

const filterInternalComments = (ticketObj, isAdmin) => {
  if (isAdmin || !ticketObj.comments?.length) return;
  ticketObj.comments = ticketObj.comments.filter((c) => !c.isInternal);
};

const toTicketObj = async (ticket, isAdmin) => {
  const obj = ticket.toObject ? ticket.toObject() : { ...ticket };
  obj.createdAt = ticket.createdAt || obj.createdAt;
  obj.updatedAt = ticket.updatedAt || obj.updatedAt;
  if (typeof ticket.getSlaStatus === 'function') obj.sla = ticket.getSlaStatus();
  await populateCommenters(obj.comments);
  filterInternalComments(obj, isAdmin);
  await refreshAttachmentUrls(obj);
  return obj;
};

const notifySafe = async (userId, opts) => {
  try { await notify(userId, opts); }
  catch (e) { logger.warn(`Ticket notification failed: ${e?.message}`); }
};

const notifyAdmins = async (title, message, excludeUserId) => {
  try {
    const adminRole = await Role.findOne({ name: 'Administrator', status: 'active' }).select('_id').lean();
    if (!adminRole) return;
    const admins = await User.find({ roleIds: adminRole._id, status: 'active' }).select('_id').lean();
    for (const a of admins) {
      if (String(a._id) !== String(excludeUserId)) {
        await notifySafe(a._id.toString(), { type: 'support_ticket', title, message, link: TICKET_LINK });
      }
    }
  } catch (e) { logger.warn(`notifyAdmins failed: ${e?.message}`); }
};

// ──────────────────────────── create ────────────────────────────

const createSupportTicket = async (ticketData, userId, files = [], user = null) => {
  let candidate = null;
  let candidateId = null;

  const isAdmin = user ? await userIsAdmin(user) : false;
  const isAgent = user ? await userIsAgent(user) : false;
  const actorUserId = user?.id?.toString?.() || user?._id?.toString?.() || String(userId);

  if (ticketData.candidateId) {
    candidate = await Employee.findById(ticketData.candidateId);
    if (!candidate) throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
    if (isAdmin) {
      candidateId = candidate._id;
    } else if (isAgent) {
      const assignedAgentId = candidate.assignedAgent?.toString?.() || '';
      if (!assignedAgentId || assignedAgentId !== actorUserId) {
        throw new ApiError(httpStatus.FORBIDDEN, 'You can only create tickets on behalf of candidates assigned to you');
      }
      candidateId = candidate._id;
    } else {
      throw new ApiError(httpStatus.FORBIDDEN, 'Only administrators or agents can create tickets on behalf of a candidate');
    }
  } else if (isAdmin) {
    candidateId = null;
  } else {
    candidate = await Employee.findOne({ owner: userId });
    candidateId = candidate?._id || null;
  }

  let attachments = [];
  if (files?.length) {
    try {
      const results = await uploadMultipleFilesToS3(files, userId, 'support-tickets');
      attachments = results.map((r) => ({ key: r.key, url: r.url, originalName: r.originalName, size: r.size, mimeType: r.mimeType, uploadedAt: new Date() }));
    } catch (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload attachments: ${error.message}`);
    }
  }

  const ticketFields = { ...ticketData };
  delete ticketFields.candidateId;

  const ticket = await SupportTicket.create({
    ...ticketFields,
    createdBy: userId,
    candidate: candidateId,
    attachments,
    activityLog: [{ action: 'created', performedBy: userId }],
  });

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket, isAdmin);

  // Notify admins about new ticket
  const creatorName = user?.name || user?.email || 'A user';
  await notifyAdmins(
    `New Support Ticket: ${ticket.ticketId}`,
    `${creatorName} created ticket "${ticket.title}" [${ticket.priority}]`,
    actorUserId
  );

  return ticketObj;
};

// ──────────────────────────── query ────────────────────────────

const querySupportTickets = async (filter, options, user) => {
  const isAdmin = await userIsAdmin(user);
  if (!isAdmin) {
    const candidate = await Employee.findOne({ owner: user.id });
    if (candidate) {
      filter.$or = [{ createdBy: user.id }, { candidate: candidate._id }];
    } else {
      filter.createdBy = user.id;
    }
  }

  // Server-side text search
  if (filter.search) {
    const q = filter.search.trim();
    delete filter.search;
    if (q) {
      const searchCondition = { $or: [{ $text: { $search: q } }, { ticketId: { $regex: q, $options: 'i' } }] };
      if (filter.$or) {
        const ownershipCondition = { $or: filter.$or };
        delete filter.$or;
        filter.$and = [ownershipCondition, searchCondition];
      } else {
        Object.assign(filter, searchCondition);
      }
    }
  }

  const result = await SupportTicket.paginate(filter, options);

  if (result.results?.length) {
    await SupportTicket.populate(result.results, POPULATE_PATHS);
    result.results = await Promise.all(
      result.results.map(async (ticket) => toTicketObj(ticket, isAdmin))
    );
  }

  return result;
};

// ──────────────────────────── get by ID ────────────────────────────

const getSupportTicketById = async (ticketId, user) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Support ticket not found');

  const isAdmin = await userIsAdmin(user);
  if (!isAdmin) {
    const candidate = await Employee.findOne({ owner: user.id });
    const canView = String(ticket.createdBy) === String(user.id) || (candidate && String(ticket.candidate) === String(candidate._id));
    if (!canView) throw new ApiError(httpStatus.FORBIDDEN, 'You can only view your own tickets');
  }

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket, isAdmin);
};

// ──────────────────────────── update ────────────────────────────

const updateSupportTicketById = async (ticketId, updateData, user) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Support ticket not found');

  const isAdmin = await userIsAdmin(user);
  if (!isAdmin) {
    const candidate = await Employee.findOne({ owner: user.id });
    const canUpdate = String(ticket.createdBy) === String(user.id) || (candidate && String(ticket.candidate) === String(candidate._id));
    if (!canUpdate) throw new ApiError(httpStatus.FORBIDDEN, 'You can only update your own tickets');
  }

  if (!isAdmin) {
    if (updateData.status && updateData.status !== 'Closed') {
      throw new ApiError(httpStatus.FORBIDDEN, 'You can only close your own tickets');
    }
    delete updateData.assignedTo;
    delete updateData.priority;
    delete updateData.category;
  }

  // Validate assignee
  if (updateData.assignedTo && isAdmin) {
    const assignedUser = await User.findById(updateData.assignedTo).select('name email');
    if (!assignedUser) throw new ApiError(httpStatus.NOT_FOUND, 'User to assign ticket to not found');
  }

  // Track changes for activity log + notifications
  const changes = [];

  if (updateData.status && updateData.status !== ticket.status) {
    const from = ticket.status;
    ticket.logActivity('status_changed', user.id, 'status', from, updateData.status);
    changes.push({ field: 'status', from, to: updateData.status });
    await ticket.updateStatus(updateData.status, user.id);
    delete updateData.status;
  }

  if (updateData.priority && updateData.priority !== ticket.priority) {
    ticket.logActivity('priority_changed', user.id, 'priority', ticket.priority, updateData.priority);
    changes.push({ field: 'priority', from: ticket.priority, to: updateData.priority });
  }

  if (updateData.category && updateData.category !== ticket.category) {
    ticket.logActivity('category_changed', user.id, 'category', ticket.category, updateData.category);
  }

  const oldAssignee = ticket.assignedTo?.toString() || '';
  const newAssignee = updateData.assignedTo ?? oldAssignee;
  if (String(newAssignee) !== String(oldAssignee)) {
    ticket.logActivity('assigned', user.id, 'assignedTo', oldAssignee || 'none', newAssignee || 'none');
    changes.push({ field: 'assignedTo', to: newAssignee });
  }

  Object.assign(ticket, updateData);
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket, isAdmin);

  // Notifications
  const actorName = user?.name || user?.email || 'Admin';
  for (const change of changes) {
    if (change.field === 'status') {
      const creatorId = ticket.createdBy?._id?.toString() || ticket.createdBy?.toString();
      if (creatorId && creatorId !== user.id) {
        await notifySafe(creatorId, {
          type: 'support_ticket',
          title: `Ticket ${change.to}: ${ticket.ticketId}`,
          message: `Your ticket "${ticket.title}" has been moved to ${change.to} by ${actorName}`,
          link: TICKET_LINK,
        });
      }
    }
    if (change.field === 'assignedTo' && change.to && change.to !== 'none') {
      await notifySafe(change.to, {
        type: 'support_ticket',
        title: `Ticket Assigned: ${ticket.ticketId}`,
        message: `${actorName} assigned ticket "${ticket.title}" to you`,
        link: TICKET_LINK,
      });
    }
  }

  return ticketObj;
};

// ──────────────────────────── add comment ────────────────────────────

const addCommentToTicket = async (ticketId, content, user, files = [], isInternal = false) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Support ticket not found');

  const isAdmin = await userIsAdmin(user);
  if (!isAdmin) {
    const candidate = await Employee.findOne({ owner: user.id });
    const canComment = String(ticket.createdBy) === String(user.id) || (candidate && String(ticket.candidate) === String(candidate._id));
    if (!canComment) throw new ApiError(httpStatus.FORBIDDEN, 'You can only comment on your own tickets');
    isInternal = false;
  }

  if (ticket.status === 'Closed') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot add comment to closed ticket');
  }

  let attachments = [];
  if (files?.length) {
    try {
      const results = await uploadMultipleFilesToS3(files, user.id, 'support-tickets/comments');
      attachments = results.map((r) => ({ key: r.key, url: r.url, originalName: r.originalName, size: r.size, mimeType: r.mimeType, uploadedAt: new Date() }));
    } catch (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload attachments: ${error.message}`);
    }
  }

  const isAdminComment = isAdmin;
  await ticket.addComment(content, user.id, isAdminComment, attachments, isInternal);

  // SLA: track first admin response
  if (isAdmin && !ticket.firstResponseAt) {
    ticket.firstResponseAt = new Date();
    await ticket.save();
  }

  ticket.logActivity(isInternal ? 'internal_note' : 'comment_added', user.id);
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket, isAdmin);

  // Notify the other party (skip for internal notes)
  if (!isInternal) {
    const actorName = user?.name || user?.email || 'Someone';
    if (isAdmin) {
      const creatorId = ticket.createdBy?._id?.toString() || ticket.createdBy?.toString();
      if (creatorId && creatorId !== user.id) {
        await notifySafe(creatorId, {
          type: 'support_ticket',
          title: `New Reply on ${ticket.ticketId}`,
          message: `${actorName} replied to your ticket "${ticket.title}"`,
          link: TICKET_LINK,
        });
      }
    } else {
      await notifyAdmins(
        `New Comment on ${ticket.ticketId}`,
        `${actorName} commented on ticket "${ticket.title}"`,
        user.id
      );
      if (ticket.assignedTo) {
        const assigneeId = ticket.assignedTo._id?.toString() || ticket.assignedTo.toString();
        if (assigneeId !== user.id) {
          await notifySafe(assigneeId, {
            type: 'support_ticket',
            title: `New Comment on ${ticket.ticketId}`,
            message: `${actorName} commented on assigned ticket "${ticket.title}"`,
            link: TICKET_LINK,
          });
        }
      }
    }
  }

  return ticketObj;
};

// ──────────────────────────── delete ────────────────────────────

const deleteSupportTicketById = async (ticketId, user) => {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Support ticket not found');

  const isAdmin = await userIsAdmin(user);
  if (!isAdmin) throw new ApiError(httpStatus.FORBIDDEN, 'Only admin can delete tickets');

  await ticket.deleteOne();
};

export {
  createSupportTicket,
  querySupportTickets,
  getSupportTicketById,
  updateSupportTicketById,
  addCommentToTicket,
  deleteSupportTicketById,
};
