import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import * as interviewBiasService from '../services/interviewBias.service.js';
import { enqueueInterviewBiasCheck } from '../services/interviewBias.enqueue.js';

const getBiasCheck = catchAsync(async (req, res) => {
  const payload = await interviewBiasService.getInterviewBiasCheck(req.params.id, req.user);
  if (!payload) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  res.send(payload);
});

const rerunBiasCheck = catchAsync(async (req, res) => {
  const existing = await interviewBiasService.getInterviewBiasCheck(req.params.id, req.user);
  if (!existing) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const result = await enqueueInterviewBiasCheck(req.params.id, { force: true });
  if (!result.enqueued && result.reason === 'meeting_not_found') {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const payload = await interviewBiasService.getInterviewBiasCheck(req.params.id, req.user);
  res.send(payload);
});

export { getBiasCheck, rerunBiasCheck };
