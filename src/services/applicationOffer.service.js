import httpStatus from 'http-status';
import JobApplication from '../models/jobApplication.model.js';
import Offer from '../models/offer.model.js';
import ApiError from '../utils/ApiError.js';
import { ensureOfferForApplication } from './meeting.service.js';
import { applicationHasSelectedInterview } from './offerInterviewBypass.service.js';

/**
 * Move an application from Interview to Offer. This is the explicit recruiter decision that used to
 * fire implicitly whenever a round was marked "selected".
 *
 * Eligibility is a floor, not a rule: at least one non-cancelled interview on this application must
 * have a result recorded as selected. Which round, and whether to advance at all, stays recruiter
 * discretion — that is why this is a separate action rather than a status side effect.
 *
 * Idempotent: an application that already has an Offer is reported as already moved and nothing is
 * written. Two recruiters clicking at once is the one case this does not fully serialise — the
 * second request falls through to `ensureOfferForApplication`, whose own duplicate-offer branch
 * treats "An offer already exists" as success. Ceiling: one live Offer per application.
 *
 * @param {string} applicationId
 * @param {string} userId - recruiter performing the move
 * @returns {Promise<{ moved: boolean, offerId: string, offerStatus: string, message: string }>}
 */
export const moveApplicationToOffer = async (applicationId, userId) => {
  const application = await JobApplication.findById(applicationId).populate('job', 'title');
  if (!application) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Job application not found');
  }

  const describe = (offer, moved) => ({
    moved,
    offerId: String(offer._id),
    offerStatus: offer.status,
    message: moved
      ? 'Application moved to Offer. Complete the offer in Offers & placement.'
      : 'This application is already at Offer stage.',
  });

  const existing = await Offer.findOne({ jobApplication: application._id }).select('_id status').lean();
  if (existing) {
    return describe(existing, false);
  }

  if (!(await applicationHasSelectedInterview(application))) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Move to Offer needs at least one interview round on this application marked Selected. Record the round result first.'
    );
  }

  const jobId = String(application.job?._id ?? application.job ?? '');
  const candidateObjId = application.candidate?._id ?? application.candidate;
  await ensureOfferForApplication(application, jobId, candidateObjId, userId);

  const offer = await Offer.findOne({ jobApplication: application._id }).select('_id status').lean();
  if (!offer) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Offer could not be created for this application.');
  }
  return describe(offer, true);
};
