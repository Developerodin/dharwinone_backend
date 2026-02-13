import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as certificateService from '../services/certificate.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Generate certificate for completed course
 */
const generateCertificate = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  
  const certificate = await certificateService.generateCertificate(studentId, moduleId);
  
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.CERTIFICATE_ISSUED,
    EntityTypes.CERTIFICATE,
    certificate.id,
    { moduleId, studentId, certificateId: certificate.certificateId },
    req
  );
  
  res.send(certificate);
});

/**
 * Get certificate for student course
 */
const getCertificate = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  
  const certificate = await certificateService.getCertificate(studentId, moduleId);
  res.send(certificate);
});

/**
 * Verify certificate by verification code (public endpoint)
 */
const verifyCertificate = catchAsync(async (req, res) => {
  const { verificationCode } = req.params;
  
  const result = await certificateService.verifyCertificate(verificationCode);
  res.send(result);
});

export {
  generateCertificate,
  getCertificate,
  verifyCertificate,
};
