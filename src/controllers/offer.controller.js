import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import {
  createOffer,
  getOfferById,
  updateOfferById,
  queryOffers,
  deleteOfferById,
} from '../services/offer.service.js';

const create = catchAsync(async (req, res) => {
  const { jobApplicationId, ...payload } = req.body;
  const userId = req.user?.id ?? req.user?._id;
  const offer = await createOffer(jobApplicationId, payload, userId);
  res.status(httpStatus.CREATED).send(offer);
});

const get = catchAsync(async (req, res) => {
  const offer = await getOfferById(req.params.offerId, req.user);
  if (!offer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }
  res.send(offer);
});

const update = catchAsync(async (req, res) => {
  const offer = await updateOfferById(req.params.offerId, req.body, req.user);
  res.send(offer);
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['jobId', 'candidateId', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryOffers(filter, options, req.user);
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  await deleteOfferById(req.params.offerId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

export { create, get, update, list, remove };
