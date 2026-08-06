import httpStatus from 'http-status';
import DevTicket, { PLATFORM_ASSIGNEE_EMAILS, PLATFORMS, DEFAULT_TESTER_EMAIL } from '../models/devTicket.model.js';
import User from '../models/user.model.js';
import ApiError from '../utils/ApiError.js';
import { uploadMultipleFilesToS3, deleteFileFromS3 } from './upload.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { notify } from './notification.service.js';
import { sendDevTicketAssignedEmail, sendDevTicketUpdatedEmail } from './email.service.js';
import { getFrontendBaseUrl } from '../utils/emailLinks.js';
import {
  buildDevTicketEmailRecipients,
  humanizeDiffRows,
  resolvePlatformEmailFromTicket,
} from './devTicketEmail.helpers.js';
import logger from '../config/logger.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

/**
 * Map platform (web | mobile) → assignee user id from PLATFORM_ASSIGNEE_EMAILS.
 * Throws if the mapped account does not exist.
 */
const resolveAssigneeForPlatform = async (platform) => {
  if (!PLATFORMS.includes(platform)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid platform: ${platform}`);
  }
  const email = PLATFORM_ASSIGNEE_EMAILS[platform];
  const assignee = await User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id email');
  if (!assignee) {
    throw new ApiError(httpStatus.NOT_FOUND, `Platform assignee account not found: ${email}`);
  }
  return assignee._id.toString();
};

/** Apply platform → assignedTo on a mutable payload (create/update/bulk). */
const applyPlatformAssignee = async (payload) => {
  if (payload.platform == null || payload.platform === '') return payload;
  const assignedTo = await resolveAssigneeForPlatform(payload.platform);
  return { ...payload, assignedTo, platform: payload.platform };
};

const escapeRegexEmail = (email) => email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findUserByEmail = async (email) =>
  User.findOne({
    email: new RegExp(`^${escapeRegexEmail(email)}$`, 'i'),
  }).select('_id name email');

const resolveDefaultTesterId = async () => {
  const tester = await findUserByEmail(DEFAULT_TESTER_EMAIL);
  if (!tester) {
    throw new ApiError(httpStatus.NOT_FOUND, `Default tester account not found: ${DEFAULT_TESTER_EMAIL}`);
  }
  return tester._id.toString();
};

const ANALYTICS_TREND_TZ = 'Asia/Kolkata';

const ATTACHMENT_PRESIGN_TTL_SEC = 7 * 24 * 3600;
const TICKET_LINK = '/dev-tickets';
const NOTIFICATION_TYPE = 'dev_ticket';
const BULK_MAX_IDS = 50;
const REOPEN_FROM_STATUSES = ['Resolved', 'Closed'];
const REOPEN_TO_STATUSES = ['Open', 'In Progress'];
const CLOSED_STATUSES = ['Resolved', 'Closed'];

const findDevTicketByRef = async (ref) => {
  const trimmed = String(ref).trim();
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    return DevTicket.findById(trimmed);
  }
  return DevTicket.findOne({ ticketId: trimmed.toUpperCase() });
};

const POPULATE_PATHS = [
  { path: 'createdBy', select: 'name email' },
  { path: 'assignedTo', select: 'name email' },
  { path: 'testedBy', select: 'name email' },
  { path: 'resolvedBy', select: 'name email' },
  { path: 'closedBy', select: 'name email' },
  { path: 'watchers', select: 'name email' },
  { path: 'links.ticket', select: 'ticketId title status' },
  { path: 'comments.commentedBy', select: 'name email' },
  { path: 'comments.mentions', select: 'name email' },
  { path: 'comments.reactions.users', select: 'name email' },
  { path: 'activityLog.performedBy', select: 'name email' },
];

// ──────────────────────────── helpers ────────────────────────────

const getUserId = (user) => user?.id?.toString?.() || user?._id?.toString?.() || String(user?.id);

const refreshAttachmentUrls = async (ticketObj) => {
  if (!ticketObj) return ticketObj;
  const refresh = async (att) => {
    if (att.key) {
      try {
        att.url = await generatePresignedDownloadUrl(att.key, ATTACHMENT_PRESIGN_TTL_SEC);
      } catch (e) {
        logger.warn(`Presign fail (key=${att.key}): ${e?.message}`);
      }
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
    if (typeof c.commentedBy === 'string') {
      needIds.add(c.commentedBy);
      continue;
    }
    if (typeof c.commentedBy === 'object' && !c.commentedBy.name) {
      needIds.add(c.commentedBy._id?.toString() || c.commentedBy.toString());
    }
  }
  if (!needIds.size) {
    for (const c of comments) {
      if (c.commentedBy?._id) {
        c.commentedBy.id = c.commentedBy._id.toString();
        delete c.commentedBy._id;
      }
    }
    return;
  }
  const users = await User.find({ _id: { $in: [...needIds] } }).select('name email').lean();
  const map = Object.fromEntries(
    users.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email }])
  );
  for (const c of comments) {
    if (!c.commentedBy) continue;
    const cid = typeof c.commentedBy === 'string'
      ? c.commentedBy
      : (c.commentedBy._id?.toString() || c.commentedBy.toString());
    if (map[cid]) c.commentedBy = map[cid];
    else if (c.commentedBy?._id) {
      c.commentedBy.id = c.commentedBy._id.toString();
      delete c.commentedBy._id;
    }
  }
};

const toTicketObj = async (ticket) => {
  const obj = ticket.toObject ? ticket.toObject() : { ...ticket };
  obj.createdAt = ticket.createdAt || obj.createdAt;
  obj.updatedAt = ticket.updatedAt || obj.updatedAt;
  await populateCommenters(obj.comments);
  await refreshAttachmentUrls(obj);
  return obj;
};

const notifySafe = async (userId, opts) => {
  try {
    await notify(userId, { ...opts, type: NOTIFICATION_TYPE, link: TICKET_LINK });
  } catch (e) {
    logger.warn(`Dev ticket notification failed: ${e?.message}`);
  }
};

const TICKET_FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  stepsToReproduce: 'Steps to reproduce',
  status: 'Status',
  priority: 'Priority',
  severity: 'Severity',
  category: 'Category',
  module: 'Module',
  pageUrl: 'Page',
  environment: 'Environment',
  platform: 'Platform',
  labels: 'Labels',
  assignedTo: 'Assignee',
};

const snapshotTicketFields = (ticket) => ({
  title: ticket.title || '',
  description: ticket.description || '',
  stepsToReproduce: ticket.stepsToReproduce || '',
  status: ticket.status || '',
  priority: ticket.priority || '',
  severity: ticket.severity || '',
  category: ticket.category || '',
  module: ticket.module || '',
  pageUrl: ticket.pageUrl || '',
  environment: ticket.environment || '',
  platform: ticket.platform || '',
  labels: [...(ticket.labels || [])].map(String).sort().join(', '),
  assignedTo: String(ticket.assignedTo?._id || ticket.assignedTo || ''),
});

const diffTicketFields = (before, after) =>
  Object.keys(TICKET_FIELD_LABELS)
    .filter((key) => String(before[key] ?? '') !== String(after[key] ?? ''))
    .map((key) => ({
      field: TICKET_FIELD_LABELS[key],
      from: before[key] || '(empty)',
      to: after[key] || '(empty)',
    }));

const serializeAttachments = (attachments = []) =>
  (attachments || []).map((a) => ({
    key: a.key,
    originalName: a.originalName,
    size: a.size,
    mimeType: a.mimeType,
    url: a.url,
  }));

const diffAttachments = (beforeList = [], afterList = []) => {
  const before = serializeAttachments(beforeList);
  const after = serializeAttachments(afterList);
  const beforeKeys = new Set(before.map((a) => a.key).filter(Boolean));
  const afterKeys = new Set(after.map((a) => a.key).filter(Boolean));
  return {
    added: after.filter((a) => a.key && !beforeKeys.has(a.key)),
    removed: before.filter((a) => a.key && !afterKeys.has(a.key)),
    unchanged: after.filter((a) => a.key && beforeKeys.has(a.key)),
  };
};

const buildTicketEmailUrl = (ticketObj) => {
  const id = ticketObj?.id || ticketObj?._id || '';
  const base = getFrontendBaseUrl();
  if (!id) return `${base}${TICKET_LINK}`;
  return `${base}${TICKET_LINK}?ticket=${encodeURIComponent(String(id))}`;
};

const resolveAssigneeEmail = async (ticketOrObj) => resolvePlatformEmailFromTicket(ticketOrObj);

const greetingForRole = (ticketObj, role) => {
  if (role === 'tester') {
    return ticketObj.testedBy?.name || ticketObj.testedBy?.email?.split('@')[0] || 'there';
  }
  return ticketObj.assignedTo?.name || 'there';
};

const buildAssigneeUserMap = async (beforeFields, ticketObj) => {
  const ids = new Set();
  const collect = (val) => {
    if (val && /^[0-9a-fA-F]{24}$/.test(String(val))) ids.add(String(val));
  };
  collect(beforeFields?.assignedTo);
  collect(ticketObj.assignedTo?._id || ticketObj.assignedTo?.id || ticketObj.assignedTo);
  if (!ids.size) return {};
  const users = await User.find({ _id: { $in: [...ids] } }).select('name email').lean();
  return Object.fromEntries(users.map((u) => [u._id.toString(), u]));
};

const emailTicketSafe = (label, promise) => {
  Promise.resolve(promise).catch((e) => logger.warn(`Dev ticket ${label} email failed: ${e?.message || e}`));
};

const sendAssignedEmailForTicket = async (ticketObj, actorName) => {
  const recipients = buildDevTicketEmailRecipients(ticketObj, {
    platformEmail: await resolveAssigneeEmail(ticketObj),
    testerEmail: DEFAULT_TESTER_EMAIL,
  });
  const ticketUrl = buildTicketEmailUrl(ticketObj);
  await Promise.all(
    recipients.map(({ email, role }) =>
      sendDevTicketAssignedEmail(email, ticketObj, {
        actorName,
        role,
        greeting: greetingForRole(ticketObj, role),
        ticketUrl,
        presignFn: generatePresignedDownloadUrl,
      })
    )
  );
};

const sendUpdatedEmailForTicket = async (ticketObj, { actorName, beforeFields, beforeAttachments }) => {
  const afterFields = snapshotTicketFields(ticketObj);
  let diffRows = diffTicketFields(beforeFields, afterFields);
  const userById = await buildAssigneeUserMap(beforeFields, ticketObj);
  diffRows = humanizeDiffRows(diffRows, userById);
  const attachmentChanges = diffAttachments(beforeAttachments, ticketObj.attachments || []);
  const hasFieldChanges = diffRows.length > 0;
  const hasAttachmentChanges =
    attachmentChanges.added.length > 0 || attachmentChanges.removed.length > 0;
  if (!hasFieldChanges && !hasAttachmentChanges) return;

  const recipients = buildDevTicketEmailRecipients(ticketObj, {
    platformEmail: await resolveAssigneeEmail(ticketObj),
    testerEmail: DEFAULT_TESTER_EMAIL,
  });
  const ticketUrl = buildTicketEmailUrl(ticketObj);
  await Promise.all(
    recipients.map(({ email, role }) =>
      sendDevTicketUpdatedEmail(email, ticketObj, {
        actorName,
        role,
        greeting: greetingForRole(ticketObj, role),
        ticketUrl,
        presignFn: generatePresignedDownloadUrl,
        diffRows,
        attachmentChanges,
      })
    )
  );
};

const uniqueRecipientIds = (ids, excludeUserId) => {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const s = id?._id?.toString?.() || id?.toString?.() || '';
    if (!s || s === excludeUserId || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

const isAdmin = async (user) => userIsAdmin(user);

const canEditTicket = async (ticket, user) => {
  const userId = getUserId(user);
  const createdBy = ticket.createdBy?._id?.toString() || ticket.createdBy?.toString();
  const assignedTo = ticket.assignedTo?._id?.toString() || ticket.assignedTo?.toString() || '';
  if (createdBy === userId || assignedTo === userId) return true;
  return isAdmin(user);
};

const assertCanEdit = async (ticket, user) => {
  if (!(await canEditTicket(ticket, user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only edit tickets you created, are assigned to, or as an admin');
  }
};

const parseMentionsFromContent = async (content) => {
  if (!content) return [];
  const matches = [...content.matchAll(/@([A-Za-z0-9][A-Za-z0-9._\s-]*[A-Za-z0-9]|[A-Za-z0-9])/g)];
  if (!matches.length) return [];
  const names = [...new Set(matches.map((m) => m[1].trim()))];
  const mentionIds = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await User.findOne({ name: { $regex: new RegExp(`^${escaped}$`, 'i') } })
      .select('_id')
      .lean();
    if (found) mentionIds.push(found._id);
  }
  return mentionIds;
};

const countsArrayToMap = (rows, keyField = '_id') => {
  const map = {};
  for (const row of rows || []) {
    if (row[keyField] != null) map[row[keyField]] = row.count;
  }
  return map;
};


const TREND_STAGE_KEYS = ['open', 'inProgress', 'resolved', 'closed'];
const STATUS_TO_TREND_KEY = {
  Open: 'open',
  'In Progress': 'inProgress',
  Resolved: 'resolved',
  Closed: 'closed',
};

const trendDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: ANALYTICS_TREND_TZ });

const shiftTrendDayIso = (isoDate, deltaDays) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  return trendDayFormatter.format(new Date(anchor + deltaDays * 86400000));
};

const endOfTrendDayMs = (isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 18, 29, 59, 999);
};

const resolveTicketStatusAt = (ticket, atMs) => {
  const createdMs = new Date(ticket.createdAt).getTime();
  if (createdMs > atMs) return null;

  let status = 'Open';
  const log = [...(ticket.activityLog || [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  for (const entry of log) {
    const entryMs = new Date(entry.createdAt).getTime();
    if (entryMs > atMs) break;
    if ((entry.action === 'status_changed' || entry.action === 'reopened') && entry.to) {
      status = entry.to;
    }
  }

  return status;
};

const buildSnapshotTrend = (tickets) => {
  const todayIso = trendDayFormatter.format(new Date());
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = shiftTrendDayIso(todayIso, -offset);
    const atMs = endOfTrendDayMs(date);
    const row = { date, open: 0, inProgress: 0, resolved: 0, closed: 0 };

    for (const ticket of tickets) {
      const status = resolveTicketStatusAt(ticket, atMs);
      const key = STATUS_TO_TREND_KEY[status];
      if (key) row[key] += 1;
    }

    days.push(row);
  }

  return days;
};

const trendHasActivity = (trend) =>
  (trend || []).some((row) => TREND_STAGE_KEYS.some((key) => (row[key] || 0) > 0));

const applyScopeFilter = (filter, user) => {
  const scope = filter.scope;
  delete filter.scope;
  if (!scope || scope === 'all') return;
  const userId = getUserId(user);
  if (scope === 'mine') filter.assignedTo = userId;
  else if (scope === 'reported') filter.createdBy = userId;
  else if (scope === 'unassigned') filter.assignedTo = null;
};

const applySearchFilter = (filter) => {
  if (!filter.search) return;
  const q = filter.search.trim();
  delete filter.search;
  if (!q) return;
  const searchCondition = { $or: [{ $text: { $search: q } }, { ticketId: { $regex: q, $options: 'i' } }] };
  if (filter.$and) {
    filter.$and.push(searchCondition);
  } else {
    Object.assign(filter, searchCondition);
  }
};

const handleReopen = (ticket, newStatus, userId) => {
  if (
    REOPEN_FROM_STATUSES.includes(ticket.status)
    && REOPEN_TO_STATUSES.includes(newStatus)
  ) {
    ticket.reopenCount = (ticket.reopenCount || 0) + 1;
    ticket.reopenedAt = new Date();
    ticket.logActivity('reopened', userId, 'status', ticket.status, newStatus);
    return true;
  }
  return false;
};

const collectWatcherIds = (ticket) => (ticket.watchers || []).map((w) => w?._id || w);

// ──────────────────────────── create ────────────────────────────

const createDevTicket = async (ticketData, userId, files = [], user = null) => {
  const actorUserId = user?.id?.toString?.() || user?._id?.toString?.() || String(userId);

  // Default platform to web; always resolve assignee from platform email map.
  const withPlatform = await applyPlatformAssignee({
    ...ticketData,
    platform: ticketData.platform || 'web',
  });
  Object.assign(ticketData, withPlatform);
  ticketData.testedBy = await resolveDefaultTesterId();

  let attachments = [];
  if (files?.length) {
    try {
      const results = await uploadMultipleFilesToS3(files, userId, 'dev-tickets');
      attachments = results.map((r) => ({
        key: r.key,
        url: r.url,
        originalName: r.originalName,
        size: r.size,
        mimeType: r.mimeType,
        uploadedAt: new Date(),
      }));
    } catch (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload attachments: ${error.message}`);
    }
  }

  const watchers = [actorUserId];
  if (ticketData.assignedTo && String(ticketData.assignedTo) !== actorUserId) {
    watchers.push(ticketData.assignedTo);
  }
  if (ticketData.testedBy && String(ticketData.testedBy) !== actorUserId) {
    watchers.push(ticketData.testedBy);
  }

  const ticket = await DevTicket.create({
    ...ticketData,
    createdBy: userId,
    watchers,
    attachments,
    activityLog: [{ action: 'created', performedBy: userId }],
  });

  if (ticketData.assignedTo && String(ticketData.assignedTo) !== actorUserId) {
    const actorName = user?.name || user?.email || 'Someone';
    await notifySafe(ticketData.assignedTo, {
      title: `Ticket Assigned: ${ticket.ticketId}`,
      message: `${actorName} assigned ticket "${ticket.title}" to you`,
    });
  }

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket);
  emailTicketSafe(
    'assigned',
    sendAssignedEmailForTicket(ticketObj, user?.name || user?.email || 'Someone')
  );
  return ticketObj;
};

// ──────────────────────────── query ────────────────────────────

const queryDevTickets = async (filter, options, user) => {
  applyScopeFilter(filter, user);

  if (filter.label) {
    filter.labels = filter.label;
    delete filter.label;
  }

  applySearchFilter(filter);

  const result = await DevTicket.paginate(filter, options);

  if (result.results?.length) {
    await DevTicket.populate(result.results, POPULATE_PATHS);
    result.results = await Promise.all(result.results.map((ticket) => toTicketObj(ticket)));
  }

  return result;
};

// ──────────────────────────── get by ID ────────────────────────────

const getDevTicketById = async (ticketId, _user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

// ──────────────────────────── update ────────────────────────────

const updateDevTicketById = async (ticketId, updateData, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  await assertCanEdit(ticket, user);

  if (updateData.platform) {
    Object.assign(updateData, await applyPlatformAssignee(updateData));
  }

  if (updateData.assignedTo) {
    const assignedUser = await User.findById(updateData.assignedTo).select('name email');
    if (!assignedUser) throw new ApiError(httpStatus.NOT_FOUND, 'User to assign ticket to not found');
  }

  const beforeFields = snapshotTicketFields(ticket);
  const beforeAttachments = serializeAttachments(ticket.attachments);
  const changes = [];
  const actorId = getUserId(user);
  const actorName = user?.name || user?.email || 'Someone';

  if (updateData.status && updateData.status !== ticket.status) {
    const from = ticket.status;
    const to = updateData.status;
    handleReopen(ticket, to, actorId);
    ticket.logActivity('status_changed', actorId, 'status', from, to);
    changes.push({ field: 'status', from, to });
    await ticket.updateStatus(to, actorId);
    delete updateData.status;
  }

  if (updateData.priority && updateData.priority !== ticket.priority) {
    ticket.logActivity('priority_changed', actorId, 'priority', ticket.priority, updateData.priority);
    changes.push({ field: 'priority', from: ticket.priority, to: updateData.priority });
  }

  if (updateData.severity && updateData.severity !== ticket.severity) {
    ticket.logActivity('severity_changed', actorId, 'severity', ticket.severity, updateData.severity);
  }

  if (updateData.category && updateData.category !== ticket.category) {
    ticket.logActivity('category_changed', actorId, 'category', ticket.category, updateData.category);
  }

  if (updateData.module != null && updateData.module !== ticket.module) {
    ticket.logActivity('module_changed', actorId, 'module', ticket.module || '', updateData.module || '');
  }

  if (updateData.platform && updateData.platform !== ticket.platform) {
    ticket.logActivity('platform_changed', actorId, 'platform', ticket.platform || '', updateData.platform);
  }

  const oldAssignee = ticket.assignedTo?.toString() || '';
  const newAssignee = updateData.assignedTo ?? oldAssignee;
  if (String(newAssignee) !== String(oldAssignee)) {
    ticket.logActivity('assigned', actorId, 'assignedTo', oldAssignee || 'none', newAssignee || 'none');
    changes.push({ field: 'assignedTo', from: oldAssignee, to: newAssignee });

    if (newAssignee && newAssignee !== 'none') {
      const watcherIds = ticket.watchers.map((w) => w?.toString?.() || String(w));
      if (!watcherIds.includes(String(newAssignee))) {
        ticket.watchers.push(newAssignee);
      }
    }
  }

  Object.assign(ticket, updateData);
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket);

  for (const change of changes) {
    if (change.field === 'status') {
      const recipients = uniqueRecipientIds(
        [ticket.createdBy, ...collectWatcherIds(ticket)],
        actorId
      );
      for (const recipientId of recipients) {
        await notifySafe(recipientId, {
          title: `Ticket ${change.to}: ${ticket.ticketId}`,
          message: `Ticket "${ticket.title}" has been moved to ${change.to} by ${actorName}`,
        });
      }
    }
    if (change.field === 'assignedTo' && change.to && change.to !== 'none' && change.to !== actorId) {
      await notifySafe(change.to, {
        title: `Ticket Assigned: ${ticket.ticketId}`,
        message: `${actorName} assigned ticket "${ticket.title}" to you`,
      });
    }
  }

  emailTicketSafe(
    'updated',
    sendUpdatedEmailForTicket(ticketObj, { actorName, beforeFields, beforeAttachments })
  );

  return ticketObj;
};

// ──────────────────────────── add comment ────────────────────────────

const addCommentToTicket = async (ticketId, content, user, files = []) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  // Everyone with devTickets.view can read a ticket, but only the reporter,
  // the assignee, or an admin may comment or attach files to it.
  await assertCanEdit(ticket, user);

  const actorId = getUserId(user);
  const admin = await isAdmin(user);
  const beforeFields = snapshotTicketFields(ticket);
  const beforeAttachments = serializeAttachments(ticket.attachments);

  let attachments = [];
  if (files?.length) {
    try {
      const results = await uploadMultipleFilesToS3(files, actorId, 'dev-tickets/comments');
      attachments = results.map((r) => ({
        key: r.key,
        url: r.url,
        originalName: r.originalName,
        size: r.size,
        mimeType: r.mimeType,
        uploadedAt: new Date(),
      }));
    } catch (error) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload attachments: ${error.message}`);
    }
  }

  const mentions = await parseMentionsFromContent(content);
  if (attachments.length) {
    ticket.attachments.push(...attachments);
  }
  await ticket.addComment(content, actorId, admin, attachments, mentions);

  ticket.logActivity('comment_added', actorId);
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket);

  const actorName = user?.name || user?.email || 'Someone';
  const recipients = uniqueRecipientIds(
    [
      ticket.createdBy,
      ticket.assignedTo,
      ...collectWatcherIds(ticket),
      ...mentions,
    ],
    actorId
  );

  for (const recipientId of recipients) {
    await notifySafe(recipientId, {
      title: `New Comment on ${ticket.ticketId}`,
      message: `${actorName} commented on ticket "${ticket.title}"`,
    });
  }

  if (attachments.length) {
    emailTicketSafe(
      'updated',
      sendUpdatedEmailForTicket(ticketObj, {
        actorName,
        beforeFields,
        beforeAttachments,
      })
    );
  }

  return ticketObj;
};

// ──────────────────────────── delete ────────────────────────────

// ──────────────────────────── ticket attachments ────────────────────────────

const MAX_TICKET_ATTACHMENTS = 10;

const addTicketAttachments = async (ticketId, files, user) => {
  if (!files?.length) throw new ApiError(httpStatus.BAD_REQUEST, 'No files uploaded');

  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');
  await assertCanEdit(ticket, user);

  if (ticket.attachments.length + files.length > MAX_TICKET_ATTACHMENTS) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A ticket can hold at most ${MAX_TICKET_ATTACHMENTS} attachments`
    );
  }

  const actorId = getUserId(user);
  const beforeFields = snapshotTicketFields(ticket);
  const beforeAttachments = serializeAttachments(ticket.attachments);
  let results;
  try {
    results = await uploadMultipleFilesToS3(files, actorId, 'dev-tickets');
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to upload attachments: ${error.message}`);
  }

  results.forEach((r) => {
    ticket.attachments.push({
      key: r.key,
      url: r.url,
      originalName: r.originalName,
      size: r.size,
      mimeType: r.mimeType,
      uploadedAt: new Date(),
    });
  });
  ticket.logActivity(
    'attachment_added',
    actorId,
    'attachments',
    '',
    results.map((r) => r.originalName).join(', ')
  );
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket);
  emailTicketSafe(
    'updated',
    sendUpdatedEmailForTicket(ticketObj, {
      actorName: user?.name || user?.email || 'Someone',
      beforeFields,
      beforeAttachments,
    })
  );
  return ticketObj;
};

const removeTicketAttachment = async (ticketId, key, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');
  await assertCanEdit(ticket, user);

  const attachment = ticket.attachments.find((a) => a.key === key);
  if (!attachment) throw new ApiError(httpStatus.NOT_FOUND, 'Attachment not found on this ticket');

  const beforeFields = snapshotTicketFields(ticket);
  const beforeAttachments = serializeAttachments(ticket.attachments);

  ticket.attachments.pull(attachment._id);
  ticket.logActivity('attachment_removed', getUserId(user), 'attachments', attachment.originalName, '');
  await ticket.save();

  // Ticket state is what users see; a stranded S3 object is not worth failing the request.
  try {
    await deleteFileFromS3(key);
  } catch (e) {
    logger.warn(`S3 delete fail (key=${key}): ${e?.message}`);
  }

  await ticket.populate(POPULATE_PATHS);
  const ticketObj = await toTicketObj(ticket);
  emailTicketSafe(
    'updated',
    sendUpdatedEmailForTicket(ticketObj, {
      actorName: user?.name || user?.email || 'Someone',
      beforeFields,
      beforeAttachments,
    })
  );
  return ticketObj;
};

const deleteDevTicketById = async (ticketId, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  await assertCanEdit(ticket, user);
  await ticket.deleteOne();
};

// ──────────────────────────── bulk update ────────────────────────────

const bulkUpdate = async (ids, action, user) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'ids must be a non-empty array');
  }
  if (ids.length > BULK_MAX_IDS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot bulk update more than ${BULK_MAX_IDS} tickets`);
  }

  if (action.platform) {
    Object.assign(action, await applyPlatformAssignee(action));
  }

  const updated = [];
  const skipped = [];

  for (const id of ids) {
    const ticket = await DevTicket.findById(id);
    if (!ticket || !(await canEditTicket(ticket, user))) {
      skipped.push(id);
      continue;
    }

    const actorId = getUserId(user);
    const actorName = user?.name || user?.email || 'Someone';
    const beforeFields = snapshotTicketFields(ticket);
    const beforeAttachments = serializeAttachments(ticket.attachments);

    if (action.status && action.status !== ticket.status) {
      handleReopen(ticket, action.status, actorId);
      ticket.logActivity('status_changed', actorId, 'status', ticket.status, action.status);
      await ticket.updateStatus(action.status, actorId);
    }

    if (action.platform && action.platform !== ticket.platform) {
      const oldPlatform = ticket.platform || '';
      ticket.platform = action.platform;
      ticket.logActivity('platform_changed', actorId, 'platform', oldPlatform, action.platform);
    }

    if (action.assignedTo != null) {
      const oldAssignee = ticket.assignedTo?.toString() || '';
      const newAssignee = action.assignedTo || '';
      if (String(newAssignee) !== String(oldAssignee)) {
        ticket.assignedTo = action.assignedTo || undefined;
        ticket.logActivity('assigned', actorId, 'assignedTo', oldAssignee || 'none', newAssignee || 'none');
        if (newAssignee) {
          const watcherIds = ticket.watchers.map((w) => w?.toString?.() || String(w));
          if (!watcherIds.includes(String(newAssignee))) ticket.watchers.push(newAssignee);
        }
      }
    }

    if (action.addLabel) {
      if (!ticket.labels.includes(action.addLabel)) {
        ticket.labels.push(action.addLabel);
        ticket.logActivity('label_added', actorId, 'labels', '', action.addLabel);
      }
    }

    await ticket.save();
    await ticket.populate(POPULATE_PATHS);
    const ticketObj = await toTicketObj(ticket);
    emailTicketSafe(
      'updated',
      sendUpdatedEmailForTicket(ticketObj, { actorName, beforeFields, beforeAttachments })
    );
    updated.push(id);
  }

  return { updated, skipped };
};

// ──────────────────────────── watchers ────────────────────────────

const addWatcher = async (ticketId, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  const userId = getUserId(user);
  const watcherIds = ticket.watchers.map((w) => w?.toString?.() || String(w));
  if (!watcherIds.includes(userId)) {
    ticket.watchers.push(userId);
    ticket.logActivity('watcher_added', userId);
    await ticket.save();
  }

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

const removeWatcher = async (ticketId, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  const userId = getUserId(user);
  ticket.watchers = ticket.watchers.filter((w) => (w?.toString?.() || String(w)) !== userId);
  ticket.logActivity('watcher_removed', userId);
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

// ──────────────────────────── links ────────────────────────────

const linkTicket = async (ticketId, { rel, ticketId: linkedTicketId }, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  await assertCanEdit(ticket, user);

  const linked = await findDevTicketByRef(linkedTicketId);
  if (!linked) throw new ApiError(httpStatus.NOT_FOUND, 'Linked ticket not found');
  if (String(linked._id) === String(ticket._id)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot link a ticket to itself');
  }

  const alreadyLinked = ticket.links.some(
    (l) => String(l.ticket) === String(linked._id) && l.rel === rel
  );
  if (!alreadyLinked) {
    ticket.links.push({ rel, ticket: linked._id });
    ticket.logActivity('link_added', getUserId(user), 'links', '', `${rel}:${linked.ticketId}`);
    await ticket.save();
  }

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

const unlinkTicket = async (ticketId, linkId, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  await assertCanEdit(ticket, user);

  const link = ticket.links.id(linkId);
  if (!link) throw new ApiError(httpStatus.NOT_FOUND, 'Link not found');

  link.deleteOne();
  ticket.logActivity('link_removed', getUserId(user), 'links', linkId, '');
  await ticket.save();

  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

// ──────────────────────────── reactions ────────────────────────────

const toggleReaction = async (ticketId, commentId, emoji, user) => {
  const ticket = await DevTicket.findById(ticketId);
  if (!ticket) throw new ApiError(httpStatus.NOT_FOUND, 'Dev ticket not found');

  const comment = ticket.comments.id(commentId);
  if (!comment) throw new ApiError(httpStatus.NOT_FOUND, 'Comment not found');

  const userId = getUserId(user);
  const reaction = comment.reactions.find((r) => r.emoji === emoji);

  if (!reaction) {
    comment.reactions.push({ emoji, users: [userId] });
  } else {
    const idx = reaction.users.findIndex((u) => String(u) === userId);
    if (idx >= 0) reaction.users.splice(idx, 1);
    else reaction.users.push(userId);
    if (reaction.users.length === 0) {
      comment.reactions = comment.reactions.filter((r) => r.emoji !== emoji);
    }
  }

  await ticket.save();
  await ticket.populate(POPULATE_PATHS);
  return toTicketObj(ticket);
};

const addReaction = async (ticketId, commentId, emoji, user) => toggleReaction(ticketId, commentId, emoji, user);

const removeReaction = async (ticketId, commentId, emoji, user) => toggleReaction(ticketId, commentId, emoji, user);

// ──────────────────────────── analytics ────────────────────────────

const getDevTicketAnalytics = async (_user) => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [facet] = await DevTicket.aggregate([
    {
      $facet: {
        statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        severityCounts: [{ $group: { _id: '$severity', count: { $sum: 1 } } }],
        priorityCounts: [{ $group: { _id: '$priority', count: { $sum: 1 } } }],
        environmentCounts: [{ $group: { _id: '$environment', count: { $sum: 1 } } }],
        topModules: [
          { $match: { module: { $nin: [null, ''] } } },
          { $group: { _id: '$module', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
          { $project: { _id: 0, module: '$_id', count: 1 } },
        ],
        openByAssignee: [
          { $match: { status: { $nin: CLOSED_STATUSES } } },
          { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],
        totalsAgg: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              open: {
                $sum: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, 0, 1] },
              },
              resolved: {
                $sum: { $cond: [{ $in: ['$status', CLOSED_STATUSES] }, 1, 0] },
              },
              avgResolutionMs: {
                $avg: {
                  $cond: [
                    { $and: [{ $ne: ['$resolvedAt', null] }, { $ne: ['$createdAt', null] }] },
                    { $subtract: ['$resolvedAt', '$createdAt'] },
                    null,
                  ],
                },
              },
            },
          },
        ],
        reopenAgg: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              reopened: { $sum: { $cond: [{ $gt: ['$reopenCount', 0] }, 1, 0] } },
            },
          },
        ],
        resolverLeaderboard: [
          {
            $match: {
              status: { $in: CLOSED_STATUSES },
              resolvedAt: { $gte: thirtyDaysAgo, $ne: null },
              resolvedBy: { $ne: null },
            },
          },
          { $group: { _id: '$resolvedBy', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ],
        oldestOpen: [
          { $match: { status: { $nin: CLOSED_STATUSES } } },
          { $sort: { createdAt: 1 } },
          { $limit: 5 },
          { $project: { _id: 0, ticketId: 1, title: 1, createdAt: 1 } },
        ],
      },
    },
  ]);

  const userIds = new Set();
  for (const row of facet.openByAssignee || []) {
    if (row._id) userIds.add(row._id.toString());
  }
  for (const row of facet.resolverLeaderboard || []) {
    if (row._id) userIds.add(row._id.toString());
  }

  const users = userIds.size
    ? await User.find({ _id: { $in: [...userIds] } }).select('name').lean()
    : [];
  const userNameMap = Object.fromEntries(users.map((u) => [u._id.toString(), u.name]));

  const totalsRow = facet.totalsAgg?.[0] || { total: 0, open: 0, resolved: 0, avgResolutionMs: null };
  const reopenRow = facet.reopenAgg?.[0] || { total: 0, reopened: 0 };
  const reopenTotal = reopenRow.total || 0;

  const now = Date.now();
  const oldestOpen = (facet.oldestOpen || []).map((t) => ({
    ticketId: t.ticketId,
    title: t.title,
    ageDays: Math.floor((now - new Date(t.createdAt).getTime()) / 86400000),
  }));

  const ticketsForTrend = await DevTicket.find({})
    .select('createdAt activityLog')
    .lean();
  const trend = buildSnapshotTrend(ticketsForTrend);

  return {
    totals: {
      total: totalsRow.total || 0,
      open: totalsRow.open || 0,
      resolved: totalsRow.resolved || 0,
      avgResolutionMs: totalsRow.avgResolutionMs || null,
    },
    reopen: {
      reopened: reopenRow.reopened || 0,
      total: reopenTotal,
      rate: reopenTotal > 0 ? (reopenRow.reopened || 0) / reopenTotal : 0,
    },
    statusCounts: countsArrayToMap(facet.statusCounts),
    severityCounts: countsArrayToMap(facet.severityCounts),
    priorityCounts: countsArrayToMap(facet.priorityCounts),
    environmentCounts: countsArrayToMap(facet.environmentCounts),
    topModules: facet.topModules || [],
    trend,
    trendHasActivity: trendHasActivity(trend),
    openByAssignee: (facet.openByAssignee || []).map((row) => ({
      name: row._id ? (userNameMap[row._id.toString()] || 'Unknown') : 'Unassigned',
      count: row.count,
    })),
    resolverLeaderboard: (facet.resolverLeaderboard || []).map((row) => ({
      name: userNameMap[row._id?.toString()] || 'Unknown',
      count: row.count,
    })),
    oldestOpen,
  };
};

export {
  createDevTicket,
  queryDevTickets,
  getDevTicketById,
  updateDevTicketById,
  addCommentToTicket,
  addTicketAttachments,
  removeTicketAttachment,
  deleteDevTicketById,
  bulkUpdate,
  addWatcher,
  removeWatcher,
  linkTicket,
  unlinkTicket,
  addReaction,
  removeReaction,
  getDevTicketAnalytics,
};
