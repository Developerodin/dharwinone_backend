import express from 'express';
import auth from '../../middlewares/auth.js';
import documentAuth from '../../middlewares/documentAuth.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import requireCandidateAttendanceList from '../../middlewares/requireCandidateAttendanceList.js';
import { uploadSingle } from '../../middlewares/upload.js';
import validate from '../../middlewares/validate.js';
import * as candidateValidation from '../../validations/candidate.validation.js';
import * as attendanceValidation from '../../validations/attendance.validation.js';
import attendanceController from '../../controllers/attendance.controller.js';
import * as candidateController from '../../controllers/candidate.controller.js';

const router = express.Router();

const canRead = [auth(), requirePermissions('candidates.read')];
const canManage = [auth(), requirePermissions('candidates.manage')];
const canUpdateJoiningDate = [auth(), requirePermissions('candidates.joiningDate')];
const canUpdateResignDate = [auth(), requirePermissions('candidates.resignDate')];

router
  .route('/')
  .post(auth(), requirePermissions('candidates.manage'), validate(candidateValidation.createCandidate), candidateController.create)
  .get(...canRead, validate(candidateValidation.getCandidates), candidateController.list);

/** Referral leads (ATS) — list must be before /:candidateId */
router.get(
  '/referral-leads',
  ...canRead,
  validate(candidateValidation.getReferralLeads),
  candidateController.listReferralLeadsHandler
);
router.get(
  '/referral-leads/stats',
  ...canRead,
  validate(candidateValidation.getReferralLeadsStats),
  candidateController.getReferralLeadsStatsHandler
);
router.get(
  '/referral-leads/export',
  ...canRead,
  validate(candidateValidation.getReferralLeadsStats),
  candidateController.exportReferralLeadsHandler
);
router.post(
  '/referral-link',
  ...canRead,
  validate(candidateValidation.postReferralLinkToken),
  candidateController.postReferralLinkToken
);
router.post(
  '/referral-leads/:candidateId/override',
  ...canManage,
  validate(candidateValidation.postReferralAttributionOverride),
  candidateController.postReferralAttributionOverride
);

/** Current user's own candidate – auth only (for role 'user' from share-candidate-form). Must be before /:candidateId. */
router
  .route('/me')
  .get(auth(), candidateController.getMyCandidate)
  .patch(auth(), validate(candidateValidation.updateMyCandidate), candidateController.updateMyCandidate);

/** All Agent-role users for ATS candidate filter (checklist) — candidates.read */
router.get(
  '/agents',
  ...canRead,
  validate(candidateValidation.listAgentsForFilter),
  candidateController.listAgentsForFilter
);

/** Per-agent assigned counts + unassigned (org-wide for employment scope) — candidates.manage */
router.get(
  '/agent-assignment-summary',
  ...canManage,
  validate(candidateValidation.getAgentAssignmentSummary),
  candidateController.getAgentAssignmentSummaryHandler
);

/** Training students ↔ agents — must be before /:candidateId */
router.get(
  '/student-agent-assignments',
  ...canManage,
  validate(candidateValidation.listStudentAgentAssignments),
  candidateController.listStudentAgentAssignmentsHandler
);

/** Company work email roster (Settings hub) — settings.company-email:* (not candidates.manage) */
router.get(
  '/company-email-assignments',
  auth(),
  requireAnyOfPermissions('company-email.read', 'company-email.manage'),
  validate(candidateValidation.listCompanyEmailAssignments),
  candidateController.listCompanyEmailAssignmentsHandler
);

router
  .route('/company-email-settings')
  .get(
    auth(),
    requireAnyOfPermissions('company-email.read', 'company-email.manage'),
    validate(candidateValidation.getCompanyEmailSettings),
    candidateController.getCompanyEmailSettings
  )
  .patch(
    auth(),
    requirePermissions('company-email.manage'),
    validate(candidateValidation.patchCompanyEmailSettings),
    candidateController.patchCompanyEmailSettings
  );

/** Active-SOP incomplete steps across current candidates — candidates.manage only */
router.get(
  '/sop-open-overview',
  ...canManage,
  validate(candidateValidation.getSopOpenOverview),
  candidateController.getSopOpenOverview
);

/** Queue in-app SOP notifications for candidates with open steps (all users with candidates.manage receive them). */
router.post('/sop-reminders/dispatch', ...canManage, candidateController.postSopRemindersDispatch);

router
  .route('/export')
  .post(...canManage, validate(candidateValidation.exportAllCandidates), candidateController.exportAll);

router
  .route('/import/excel')
  .post(...canManage, uploadSingle('file'), candidateController.importExcel);

router
  .route('/salary-slips/:candidateId')
  .post(...canRead, validate(candidateValidation.addSalarySlip), candidateController.addSalarySlip);

/** Salary slip download: auth only (like /documents/.../download). Owner access is enforced in getSalarySlipDownloadUrl — not candidates.read (so profile owners can view their own slips). */
router
  .route('/salary-slips/:candidateId/:salarySlipIndex')
  .get(documentAuth, validate(candidateValidation.downloadSalarySlip), candidateController.downloadSalarySlip)
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
  .route('/:candidateId/assign-agent')
  .post(...canManage, validate(candidateValidation.assignAgent), candidateController.assignAgent);

router
  .route('/:candidateId/company-assigned-email')
  .post(
    ...canManage,
    validate(candidateValidation.assignCompanyAssignedEmail),
    candidateController.assignCompanyAssignedEmail
  );

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
  .patch(...canUpdateJoiningDate, validate(candidateValidation.updateJoiningDate), candidateController.updateJoining);

router
  .route('/:candidateId/resign-date')
  .patch(...canUpdateResignDate, validate(candidateValidation.updateResignDate), candidateController.updateResign);

/** Training attendance for this candidate (Student or user-based punch) — must be before generic /:candidateId */
router.get(
  '/:candidateId/attendance',
  auth(),
  requireCandidateAttendanceList,
  validate(attendanceValidation.listAttendanceCandidate),
  attendanceController.getAttendanceByCandidate
);

router.get(
  '/:candidateId/sop-status',
  auth(),
  validate(candidateValidation.getCandidateSopStatus),
  candidateController.getSopStatus
);

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
