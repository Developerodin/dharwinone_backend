import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import {
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
} from '../services/devTicket.service.js';

const create = catchAsync(async (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  const ticket = await createDevTicket(req.body, req.user.id, files, req.user);
  res.status(httpStatus.CREATED).send(ticket);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'priority', 'severity', 'category', 'module', 'environment', 'label', 'search', 'scope']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryDevTickets(filter, options, req.user);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const ticket = await getDevTicketById(req.params.ticketId, req.user);
  res.send(ticket);
});

const update = catchAsync(async (req, res) => {
  const ticket = await updateDevTicketById(req.params.ticketId, req.body, req.user);
  res.send(ticket);
});

const remove = catchAsync(async (req, res) => {
  await deleteDevTicketById(req.params.ticketId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

const addComment = catchAsync(async (req, res) => {
  const { content } = req.body;
  const files = req.files || (req.file ? [req.file] : []);
  const ticket = await addCommentToTicket(req.params.ticketId, content, req.user, files);
  res.status(httpStatus.OK).send(ticket);
});

const attachmentsAdd = catchAsync(async (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);
  const ticket = await addTicketAttachments(req.params.ticketId, files, req.user);
  res.status(httpStatus.CREATED).send(ticket);
});

const attachmentRemove = catchAsync(async (req, res) => {
  const ticket = await removeTicketAttachment(req.params.ticketId, req.query.key, req.user);
  res.send(ticket);
});

const bulk = catchAsync(async (req, res) => {
  const { ids, action } = req.body;
  const result = await bulkUpdate(ids, action, req.user);
  res.send(result);
});

const watch = catchAsync(async (req, res) => {
  const ticket = await addWatcher(req.params.ticketId, req.user);
  res.send(ticket);
});

const unwatch = catchAsync(async (req, res) => {
  const ticket = await removeWatcher(req.params.ticketId, req.user);
  res.send(ticket);
});

const link = catchAsync(async (req, res) => {
  const ticket = await linkTicket(req.params.ticketId, req.body, req.user);
  res.send(ticket);
});

const unlink = catchAsync(async (req, res) => {
  const ticket = await unlinkTicket(req.params.ticketId, req.params.linkId, req.user);
  res.send(ticket);
});

const reactAdd = catchAsync(async (req, res) => {
  const { commentId, emoji } = req.body;
  const ticket = await addReaction(req.params.ticketId, commentId, emoji, req.user);
  res.send(ticket);
});

const reactRemove = catchAsync(async (req, res) => {
  const { commentId, emoji } = req.body;
  const ticket = await removeReaction(req.params.ticketId, commentId, emoji, req.user);
  res.send(ticket);
});

const analytics = catchAsync(async (req, res) => {
  const result = await getDevTicketAnalytics(req.user);
  res.send(result);
});

export {
  create,
  list,
  get,
  update,
  remove,
  addComment,
  attachmentsAdd,
  attachmentRemove,
  bulk,
  watch,
  unwatch,
  link,
  unlink,
  reactAdd,
  reactRemove,
  analytics,
};
