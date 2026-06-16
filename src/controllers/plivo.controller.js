import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import plivoService from '../services/plivo.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getAvailableNumbers = catchAsync(async (req, res) => {
  const { countryIso, type, pattern, services, city, region, limit, offset } = req.query;
  const result = await plivoService.searchAvailableNumbers({
    countryIso,
    type,
    pattern,
    services,
    city,
    region,
    limit,
    offset,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to search Plivo numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    hasMore: result.hasMore,
    offset: result.offset,
    limit: result.limit,
    total: result.total,
  });
});

const buyNumber = catchAsync(async (req, res) => {
  const { number } = req.body;
  const result = await plivoService.buyNumber(number);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to buy Plivo number');
  }

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.PHONE_NUMBER_PURCHASE,
    EntityTypes.PHONE_NUMBER,
    result.number,
    { number: result.number },
    req
  );

  res.status(httpStatus.OK).send({
    success: true,
    number: result.number,
    message: result.message,
  });
});

const getOwnedNumbers = catchAsync(async (req, res) => {
  const { type, alias, limit, offset } = req.query;
  const result = await plivoService.listOwnedNumbers({ type, alias, limit, offset });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to list Plivo numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    total: result.total,
  });
});

export { getAvailableNumbers, buyNumber, getOwnedNumbers };
