import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import Candidate from '../models/candidate.model.js';

/**
 * Authorize listing attendance for an ATS candidate (by candidate id).
 * Same idea as requireUserAttendanceView: owner, students.*, or candidates.* when a Candidate row exists.
 */
const requireCandidateAttendanceList = async (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }

  const candidateId = req.params.candidateId;
  if (!candidateId) {
    return next(new ApiError(httpStatus.BAD_REQUEST, 'Candidate ID required'));
  }

  const candidate = await Candidate.findById(candidateId).select('owner').lean();
  if (!candidate) {
    return next(new ApiError(httpStatus.NOT_FOUND, 'Candidate not found'));
  }

  const targetOwnerId = candidate.owner?.toString?.();
  const userId = req.user.id || req.user._id?.toString?.();

  if (userId && targetOwnerId && userId === targetOwnerId) {
    return next();
  }

  const permissions = req.authContext?.permissions;
  const grantingStudents = getGrantingPermissions('students.read').concat(getGrantingPermissions('students.manage'));
  if (permissions && grantingStudents.some((p) => permissions.has(p))) {
    return next();
  }

  const grantingCandidates = getGrantingPermissions('candidates.read').concat(getGrantingPermissions('candidates.manage'));
  if (permissions && grantingCandidates.some((p) => permissions.has(p))) {
    return next();
  }

  return next(new ApiError(httpStatus.FORBIDDEN, "You do not have permission to view this candidate's attendance"));
};

export default requireCandidateAttendanceList;
