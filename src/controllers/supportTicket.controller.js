import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createSupportTicket,
  querySupportTickets,
  getSupportTicketById,
  updateSupportTicketById,
  addCommentToTicket,
  deleteSupportTicketById,
} from '../services/supportTicket.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const create = catchAsync(async (req, res) => {
  const files = req.files || (req.file ? [req.file] : []);

  if (req.body.candidateId && !(await userIsAdmin(req.user))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only admins can create tickets on behalf of candidates');
  }

  const ticket = await createSupportTicket(req.body, req.user.id, files, req.user);
  res.status(httpStatus.CREATED).send(ticket);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'priority', 'category']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await querySupportTickets(filter, options, req.user);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const ticket = await getSupportTicketById(req.params.ticketId, req.user);
  res.send(ticket);
});

const update = catchAsync(async (req, res) => {
  const ticket = await updateSupportTicketById(req.params.ticketId, req.body, req.user);
  res.send(ticket);
});

const remove = catchAsync(async (req, res) => {
  await deleteSupportTicketById(req.params.ticketId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

const addComment = catchAsync(async (req, res) => {
  const { content } = req.body;
  const files = req.files || (req.file ? [req.file] : []);
  const ticket = await addCommentToTicket(req.params.ticketId, content, req.user, files);
  res.status(httpStatus.OK).send(ticket);
});

export { create, list, get, update, remove, addComment };
