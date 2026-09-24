import catchAsync from '../utils/catchAsync.js';
import InterviewerAvailability from '../models/interviewerAvailability.model.js';
import * as holdService from '../services/interviewHold.service.js';
import * as slotService from '../services/interviewSlot.service.js';
import { formatSpoken } from '../services/interviewBooking.service.js';

const currentUserId = (req) => String(req.user?._id || req.user?.id);

const emptyAvailability = (userId) => ({
  user: userId,
  timezone: 'Asia/Kolkata',
  bufferMinutes: 15,
  weekly: [],
  overrides: [],
});

const readAvailability = async (userId) => {
  const doc = await InterviewerAvailability.findOne({ user: userId });
  return doc ? doc.toJSON() : emptyAvailability(userId);
};

const writeAvailability = async (userId, body) => {
  const doc = await InterviewerAvailability.findOneAndUpdate(
    { user: userId },
    { $set: { ...body, user: userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  return doc.toJSON();
};

export const getMyAvailability = catchAsync(async (req, res) => {
  res.send(await readAvailability(currentUserId(req)));
});

export const putMyAvailability = catchAsync(async (req, res) => {
  res.send(await writeAvailability(currentUserId(req), req.body));
});

export const getUserAvailability = catchAsync(async (req, res) => {
  res.send(await readAvailability(req.params.userId));
});

export const putUserAvailability = catchAsync(async (req, res) => {
  res.send(await writeAvailability(req.params.userId, req.body));
});

export const listHolds = catchAsync(async (req, res) => {
  const results = await holdService.listHolds({ status: req.query.status, jobId: req.query.jobId });
  res.send({ results });
});

export const approveHold = catchAsync(async (req, res) => {
  const { hold, meeting } = await holdService.approveHold(req.params.id, req.user);
  res.send({ hold, meetingId: meeting?._id || meeting?.id || null });
});

export const rejectHold = catchAsync(async (req, res) => {
  const hold = await holdService.rejectHold(req.params.id, req.user, req.body?.reason);
  res.send({ hold });
});

export const previewSlots = catchAsync(async (req, res) => {
  const { applicationId, limit } = req.query;
  const tz = req.query.tz || 'Asia/Kolkata';
  const slots = await slotService.getFreeSlots({ applicationId, limit, tz });
  res.send({
    slots: slots.map((s) => ({
      slot_id: slotService.encodeSlotId({ applicationId, start: s.start }),
      start: s.start,
      end: s.end,
      interviewerIds: s.interviewerIds,
      spoken: formatSpoken(s.start, tz),
    })),
  });
});
