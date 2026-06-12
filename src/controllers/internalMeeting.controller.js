import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as internalMeetingService from '../services/internalMeeting.service.js';
import * as meetingSeriesService from '../services/meetingSeries.service.js';
import recordingService from '../services/recording.service.js';

const create = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  // A recurrence rule routes to the series path; otherwise a plain one-off meeting.
  if (req.body.recurrence && req.body.recurrence.frequency) {
    const series = await meetingSeriesService.createMeetingSeries(req.body, userId);
    return res.status(httpStatus.CREATED).send(series);
  }
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
  const mode = req.query.mode || 'single';
  // Scope check + detect whether this is a series occurrence.
  const existing = await internalMeetingService.getInternalMeetingById(req.params.id, req.user);
  if (!existing) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  if (existing.seriesId) {
    const result = await meetingSeriesService.updateSeries(req.params.id, req.body, mode);
    return res.send(result);
  }
  const result = await internalMeetingService.updateInternalMeetingById(req.params.id, req.body);
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  const mode = req.query.mode || 'single';
  const existing = await internalMeetingService.getInternalMeetingById(req.params.id, req.user);
  if (!existing) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  if (existing.seriesId) {
    const purge = req.query.purge === true || req.query.purge === 'true';
    if (purge) {
      if (mode !== 'series') {
        return res.status(httpStatus.BAD_REQUEST).send({
          message: 'Permanent series removal requires mode=series',
        });
      }
      const result = await meetingSeriesService.purgeSeries(req.params.id);
      return res.send(result);
    }
    const result = await meetingSeriesService.cancelSeries(req.params.id, mode);
    return res.send(result);
  }
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
