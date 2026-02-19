import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as meetingService from '../services/meeting.service.js';

const create = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.createMeeting(req.body, userId);
  res.status(httpStatus.CREATED).send(result);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await meetingService.queryMeetings(filter, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const meeting = await meetingService.getMeetingById(req.params.id);
  if (!meeting) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  res.send(meeting);
});

const update = catchAsync(async (req, res) => {
  const result = await meetingService.updateMeetingById(req.params.id, req.body);
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  await meetingService.deleteMeetingById(req.params.id);
  res.status(httpStatus.NO_CONTENT).send();
});

const resendInvitations = catchAsync(async (req, res) => {
  const result = await meetingService.resendMeetingInvitations(req.params.id);
  res.send(result);
});

export { create, list, get, update, remove, resendInvitations };
