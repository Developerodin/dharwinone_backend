import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  queryPlacements,
  getPlacementById,
  updatePlacementStatus,
} from '../services/placement.service.js';

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['jobId', 'candidateId', 'status', 'preBoardingStatus']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryPlacements(filter, options, req.user);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const placement = await getPlacementById(req.params.placementId, req.user);
  if (!placement) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Placement not found');
  }
  res.send(placement);
});

const update = catchAsync(async (req, res) => {
  const placement = await updatePlacementStatus(req.params.placementId, req.body, req.user);
  res.send(placement);
});

export { list, get, update };
