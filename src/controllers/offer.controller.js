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
  generateOfferLetter,
  getLetterDefaultsForTitle,
  deriveRoleResponsibilities,
  shareOfferWithCandidate,
} from '../services/offer.service.js';
import * as jobService from '../services/job.service.js';
import { enhanceOfferLetterRoles } from '../services/moduleOpenAI.service.js';

// Forward authContext onto req.user so service-layer pipeline-perm bypass can read permissions.
const withAuthContext = (req) => {
  if (req.user && req.authContext) req.user.authContext = req.authContext;
};

const create = catchAsync(async (req, res) => {
  withAuthContext(req);
  const { jobApplicationId, ...payload } = req.body;
  const userId = req.user?.id ?? req.user?._id;
  const raw = jobApplicationId != null && String(jobApplicationId).trim() ? String(jobApplicationId).trim() : null;
  const offer = await createOffer(raw, payload, userId);
  res.status(httpStatus.CREATED).send(offer);
});

const get = catchAsync(async (req, res) => {
  withAuthContext(req);
  const offer = await getOfferById(req.params.offerId, req.user);
  if (!offer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Offer not found');
  }
  res.send(offer);
});

const update = catchAsync(async (req, res) => {
  withAuthContext(req);
  const offer = await updateOfferById(req.params.offerId, req.body, req.user);
  res.send(offer);
});

const list = catchAsync(async (req, res) => {
  withAuthContext(req);
  const filter = pick(req.query, ['jobId', 'candidateId', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryOffers(filter, options, req.user);
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  withAuthContext(req);
  await deleteOfferById(req.params.offerId, req.user);
  res.status(httpStatus.NO_CONTENT).send();
});

const letterDefaults = catchAsync(async (req, res) => {
  const base = getLetterDefaultsForTitle(String(req.query.positionTitle || ''));
  if (req.query.jobId) {
    const job = await jobService.getJobById(req.query.jobId);
    const derived = deriveRoleResponsibilities(job);
    if (derived.length) base.roleResponsibilities = derived;
    const jobDesc = typeof job?.jobDescription === 'string' ? job.jobDescription.trim() : '';
    if (jobDesc) base.positionOverviewHtml = jobDesc;
  }
  res.send(base);
});

const shareOffer = catchAsync(async (req, res) => {
  withAuthContext(req);
  const result = await shareOfferWithCandidate(req.params.offerId, req.user, req.body);
  res.send(result);
});

const generateLetter = catchAsync(async (req, res) => {
  withAuthContext(req);
  const offer = await generateOfferLetter(req.params.offerId, req.user, req.body);
  res.send(offer);
});

const enhanceRoles = catchAsync(async (req, res) => {
  const { jobTitle, jobDescription, existingRoles, existingTraining, isInternship, enhanceFocus } = req.body;
  const intern = !!isInternship;
  const resolvedFocus = !intern
    ? 'roles'
    : enhanceFocus === 'training' || enhanceFocus === 'both'
      ? enhanceFocus
      : 'roles';
  const result = await enhanceOfferLetterRoles({
    jobTitle,
    jobDescription: jobDescription ?? '',
    existingRoles: existingRoles || '',
    existingTraining: existingTraining || '',
    isInternship: intern,
    enhanceFocus: intern ? resolvedFocus : 'roles',
  });
  const payload = {};
  if (result.lines?.length) {
    payload.lines = result.lines;
    payload.text = result.lines.join('\n');
  }
  if (result.trainingOutcomes?.length) {
    payload.trainingLines = result.trainingOutcomes;
    payload.trainingText = result.trainingOutcomes.join('\n');
  }
  res.send(payload);
});

export {
  create,
  get,
  update,
  list,
  remove,
  letterDefaults,
  generateLetter,
  enhanceRoles,
  shareOffer,
};
