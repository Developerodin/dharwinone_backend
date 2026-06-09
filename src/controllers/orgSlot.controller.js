import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as orgSlotService from '../services/orgSlot.service.js';
import { persistActivityLogFailSoft } from '../services/activityLog.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id);

const persistEnvelope = async (req, envelope) => {
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  return envelope.result;
};

export const listOrgSlots = catchAsync(async (req, res) => {
  res.send(await orgSlotService.listOrgSlots(req.query));
});

export const listVacantForChart = catchAsync(async (req, res) => {
  res.send(await orgSlotService.listVacantSlotsForChart());
});

export const createOrgSlot = catchAsync(async (req, res) => {
  const envelope = await orgSlotService.createOrgSlot(req.body, req.user?._id);
  const result = await persistEnvelope(req, envelope);
  res.status(httpStatus.CREATED).send(result);
});

export const updateOrgSlot = catchAsync(async (req, res) => {
  const envelope = await orgSlotService.updateOrgSlot(req.params.slotId, req.body);
  res.send(await persistEnvelope(req, envelope));
});
