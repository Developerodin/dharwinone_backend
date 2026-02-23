import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as meetingService from '../services/meeting.service.js';
import recordingService from '../services/recording.service.js';

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
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.updateMeetingById(req.params.id, req.body, userId);
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

const getRecordings = catchAsync(async (req, res) => {
  const list = await recordingService.listByMeetingId(req.params.id);
  res.send(list);
});

const endMeetingByRoomPublic = catchAsync(async (req, res) => {
  const { roomName, hostEmail } = req.body;
  const result = await meetingService.endMeetingByRoomPublic(roomName, hostEmail);
  res.send(result);
});

const moveToPreboarding = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.moveMeetingToPreboarding(req.params.id, userId);
  res.send(result);
});

export { create, list, get, update, remove, resendInvitations, getRecordings, endMeetingByRoomPublic, moveToPreboarding };
