import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as mentorService from '../services/mentor.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getMentors = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['status', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await mentorService.queryMentors(filter, options);
  res.send(result);
});

const getMentor = catchAsync(async (req, res) => {
  const mentor = await mentorService.getMentorById(req.params.mentorId);
  if (!mentor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Mentor not found');
  }
  res.send(mentor);
});

const updateMentor = catchAsync(async (req, res) => {
  const mentor = await mentorService.updateMentorById(req.params.mentorId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.MENTOR_UPDATE,
    EntityTypes.MENTOR,
    mentor.id,
    {},
    req
  );
  res.send(mentor);
});

const deleteMentor = catchAsync(async (req, res) => {
  await mentorService.deleteMentorById(req.params.mentorId);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.MENTOR_DELETE,
    EntityTypes.MENTOR,
    req.params.mentorId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

const uploadProfileImage = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No file provided');
  }

  const mentor = await mentorService.updateMentorProfileImage(req.params.mentorId, req.file, req.user);
  res.status(httpStatus.OK).send(mentor);
});

const getProfileImage = catchAsync(async (req, res) => {
  const data = await mentorService.getMentorProfileImageUrl(req.params.mentorId);

  // If client explicitly wants JSON (e.g., for frontend), return JSON
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(httpStatus.OK).send({
      success: true,
      data,
    });
  }

  // Default: redirect to presigned URL for direct preview/download
  return res.redirect(data.url);
});

export {
  getMentors,
  getMentor,
  updateMentor,
  deleteMentor,
  uploadProfileImage,
  getProfileImage,
};
