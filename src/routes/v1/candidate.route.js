import express from 'express';
import auth from '../../middlewares/auth.js';
import documentAuth from '../../middlewares/documentAuth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as candidateValidation from '../../validations/candidate.validation.js';
import * as candidateController from '../../controllers/candidate.controller.js';

const router = express.Router();

const canRead = [auth(), requirePermissions('candidates.read')];
const canManage = [auth(), requirePermissions('candidates.manage')];

router
  .route('/')
  .post(auth(), requirePermissions('candidates.manage'), validate(candidateValidation.createCandidate), candidateController.create)
  .get(...canRead, validate(candidateValidation.getCandidates), candidateController.list);

router
  .route('/export')
  .post(...canManage, validate(candidateValidation.exportAllCandidates), candidateController.exportAll);

router
  .route('/salary-slips/:candidateId')
  .post(...canRead, validate(candidateValidation.addSalarySlip), candidateController.addSalarySlip);

router
  .route('/salary-slips/:candidateId/:salarySlipIndex')
  .patch(...canRead, validate(candidateValidation.updateSalarySlip), candidateController.updateSalarySlip)
  .delete(...canRead, validate(candidateValidation.deleteSalarySlip), candidateController.deleteSalarySlip);

router
  .route('/:candidateId/resend-verification-email')
  .post(...canManage, validate(candidateValidation.resendVerificationEmail), candidateController.resendVerificationEmail);

router
  .route('/:candidateId/export')
  .post(...canRead, validate(candidateValidation.exportCandidate), candidateController.exportProfile);

router
  .route('/:candidateId/notes')
  .post(...canRead, validate(candidateValidation.addRecruiterNote), candidateController.addNote);

router
  .route('/:candidateId/feedback')
  .post(...canRead, validate(candidateValidation.addRecruiterFeedback), candidateController.addFeedback);

router
  .route('/:candidateId/assign-recruiter')
  .post(...canManage, validate(candidateValidation.assignRecruiter), candidateController.assignRecruiter);

router
  .route('/week-off')
  .post(...canManage, validate(candidateValidation.updateWeekOff), candidateController.updateWeekOff);

router
  .route('/:candidateId/week-off')
  .get(...canRead, validate(candidateValidation.getWeekOff), candidateController.getWeekOff);

router
  .route('/assign-shift')
  .post(...canManage, validate(candidateValidation.assignShift), candidateController.assignShift);

router
  .route('/:candidateId/joining-date')
  .patch(...canManage, validate(candidateValidation.updateJoiningDate), candidateController.updateJoining);

router
  .route('/:candidateId/resign-date')
  .patch(...canManage, validate(candidateValidation.updateResignDate), candidateController.updateResign);

router
  .route('/:candidateId')
  .get(...canRead, validate(candidateValidation.getCandidate), candidateController.get)
  .patch(...canRead, validate(candidateValidation.updateCandidate), candidateController.update)
  .delete(...canManage, validate(candidateValidation.deleteCandidate), candidateController.remove);

router
  .route('/documents/:candidateId')
  .get(...canRead, validate(candidateValidation.getDocuments), candidateController.getCandidateDocuments);

router
  .route('/documents/:candidateId/:documentIndex/download')
  .get(documentAuth, candidateController.downloadDocument);

router
  .route('/documents/verify/:candidateId/:documentIndex')
  .patch(...canManage, validate(candidateValidation.verifyDocument), candidateController.verifyDocumentStatus);

router
  .route('/documents/status/:candidateId')
  .get(...canRead, validate(candidateValidation.getDocumentStatus), candidateController.getCandidateDocumentStatus);

router
  .route('/share/:candidateId')
  .post(...canRead, validate(candidateValidation.shareCandidateProfile), candidateController.shareProfile);

router
  .route('/public/candidate/:candidateId')
  .get(candidateController.getPublicProfile);

export default router;
