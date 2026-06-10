import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as internalMeetingService from '../services/internalMeeting.service.js';
import recordingService from '../services/recording.service.js';

const create = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await internalMeetingService.createInternalMeeting(req.body, userId);
  res.status(httpStatus.CREATED).send(result);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await internalMeetingService.queryInternalMeetings(filter, options, req.user);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const meeting = await internalMeetingService.getInternalMeetingById(req.params.id, req.user);
  if (!meeting) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  res.send(meeting);
});

const update = catchAsync(async (req, res) => {
  const result = await internalMeetingService.updateInternalMeetingById(req.params.id, req.body);
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  await internalMeetingService.deleteInternalMeetingById(req.params.id);
  res.status(httpStatus.NO_CONTENT).send();
});

const resendInvitations = catchAsync(async (req, res) => {
  const result = await internalMeetingService.resendInternalMeetingInvitations(req.params.id);
  res.send(result);
});

const getRecordings = catchAsync(async (req, res) => {
  const list = await recordingService.listByMeetingId(req.params.id);
  res.send(list);
});

export { create, list, get, update, remove, resendInvitations, getRecordings };
