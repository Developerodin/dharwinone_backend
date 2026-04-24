import express from 'express';
import auth from '../../middlewares/auth.js';
import documentAuth from '../../middlewares/documentAuth.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import requireCandidateAttendanceList from '../../middlewares/requireCandidateAttendanceList.js';
import { uploadSingle } from '../../middlewares/upload.js';
import validate from '../../middlewares/validate.js';
import * as employeeValidation from '../../validations/employee.validation.js';
import * as attendanceValidation from '../../validations/attendance.validation.js';
import attendanceController from '../../controllers/attendance.controller.js';
import * as employeeController from '../../controllers/employee.controller.js';

const router = express.Router();

const canRead = [auth(), requirePermissions('candidates.read')];
const canManage = [auth(), requirePermissions('candidates.manage')];
const canUpdateJoiningDate = [auth(), requirePermissions('candidates.joiningDate')];
const canUpdateResignDate = [auth(), requirePermissions('candidates.resignDate')];

router
  .route('/')
  .post(auth(), requirePermissions('candidates.manage'), validate(employeeValidation.createCandidate), employeeController.create)
  .get(...canRead, validate(employeeValidation.getCandidates), employeeController.list);

/** Referral leads (ATS) — list must be before /:candidateId */
router.get(
  '/referral-leads',
  ...canRead,
  validate(employeeValidation.getReferralLeads),
  employeeController.listReferralLeadsHandler
);
router.get(
  '/referral-leads/stats',
  ...canRead,
  validate(employeeValidation.getReferralLeadsStats),
  employeeController.getReferralLeadsStatsHandler
);
router.get(
  '/referral-leads/export',
  ...canRead,
  validate(employeeValidation.getReferralLeadsStats),
  employeeController.exportReferralLeadsHandler
);
router.post(
  '/referral-link',
  ...canRead,
  validate(employeeValidation.postReferralLinkToken),
  employeeController.postReferralLinkToken
);
router.post(
  '/referral-leads/:candidateId/override',
  ...canManage,
  validate(employeeValidation.postReferralAttributionOverride),
  employeeController.postReferralAttributionOverride
);

/** Current user's own candidate – auth only (for role 'user' from share-candidate-form). Must be before /:candidateId. */
router
  .route('/me')
  .get(auth(), employeeController.getMyCandidate)
  .patch(auth(), validate(employeeValidation.updateMyCandidate), employeeController.updateMyCandidate);

/** All Agent-role users for ATS candidate filter (checklist) — candidates.read */
router.get(
  '/agents',
  ...canRead,
  validate(employeeValidation.listAgentsForFilter),
  employeeController.listAgentsForFilter
);

/** Per-agent assigned counts + unassigned (org-wide for employment scope) — candidates.manage */
router.get(
  '/agent-assignment-summary',
  ...canManage,
  validate(employeeValidation.getAgentAssignmentSummary),
  employeeController.getAgentAssignmentSummaryHandler
);

/** Training students ↔ agents — must be before /:candidateId */
router.get(
  '/student-agent-assignments',
  ...canManage,
  validate(employeeValidation.listStudentAgentAssignments),
  employeeController.listStudentAgentAssignmentsHandler
);

/** Company work email roster (Settings hub) — settings.company-email:* (not candidates.manage) */
router.get(
  '/company-email-assignments',
  auth(),
  requireAnyOfPermissions('company-email.read', 'company-email.manage'),
  validate(employeeValidation.listCompanyEmailAssignments),
  employeeController.listCompanyEmailAssignmentsHandler
);

router
  .route('/company-email-settings')
  .get(
    auth(),
    requireAnyOfPermissions('company-email.read', 'company-email.manage'),
    validate(employeeValidation.getCompanyEmailSettings),
    employeeController.getCompanyEmailSettings
  )
  .patch(
    auth(),
    requirePermissions('company-email.manage'),
    validate(employeeValidation.patchCompanyEmailSettings),
    employeeController.patchCompanyEmailSettings
  );

/** Active-SOP incomplete steps across current candidates — candidates.manage only */
router.get(
  '/sop-open-overview',
  ...canManage,
  validate(employeeValidation.getSopOpenOverview),
  employeeController.getSopOpenOverview
);

/** Queue in-app SOP notifications for candidates with open steps (all users with candidates.manage receive them). */
router.post('/sop-reminders/dispatch', ...canManage, employeeController.postSopRemindersDispatch);

router
  .route('/export')
  .post(...canManage, validate(employeeValidation.exportAllCandidates), employeeController.exportAll);

router
  .route('/import/excel')
  .post(...canManage, uploadSingle('file'), employeeController.importExcel);

router
  .route('/salary-slips/:candidateId')
  .post(...canRead, validate(employeeValidation.addSalarySlip), employeeController.addSalarySlip);

/** Salary slip download: auth only (like /documents/.../download). Owner access is enforced in getSalarySlipDownloadUrl — not candidates.read (so profile owners can view their own slips). */
router
  .route('/salary-slips/:candidateId/:salarySlipIndex')
  .get(documentAuth, validate(employeeValidation.downloadSalarySlip), employeeController.downloadSalarySlip)
  .patch(...canRead, validate(employeeValidation.updateSalarySlip), employeeController.updateSalarySlip)
  .delete(...canRead, validate(employeeValidation.deleteSalarySlip), employeeController.deleteSalarySlip);

router
  .route('/:candidateId/resend-verification-email')
  .post(...canManage, validate(employeeValidation.resendVerificationEmail), employeeController.resendVerificationEmail);

router
  .route('/:candidateId/export')
  .post(...canRead, validate(employeeValidation.exportCandidate), employeeController.exportProfile);

router
  .route('/:candidateId/notes')
  .post(...canRead, validate(employeeValidation.addRecruiterNote), employeeController.addNote);

router
  .route('/:candidateId/feedback')
  .post(...canRead, validate(employeeValidation.addRecruiterFeedback), employeeController.addFeedback);

router
  .route('/:candidateId/assign-recruiter')
  .post(...canManage, validate(employeeValidation.assignRecruiter), employeeController.assignRecruiter);

router
  .route('/:candidateId/assign-agent')
  .post(...canManage, validate(employeeValidation.assignAgent), employeeController.assignAgent);

router
  .route('/:candidateId/company-assigned-email')
  .post(
    ...canManage,
    validate(employeeValidation.assignCompanyAssignedEmail),
    employeeController.assignCompanyAssignedEmail
  );

router
  .route('/week-off')
  .post(...canManage, validate(employeeValidation.updateWeekOff), employeeController.updateWeekOff);

router
  .route('/:candidateId/week-off')
  .get(...canRead, validate(employeeValidation.getWeekOff), employeeController.getWeekOff);

router
  .route('/assign-shift')
  .post(...canManage, validate(employeeValidation.assignShift), employeeController.assignShift);

router
  .route('/:candidateId/joining-date')
  .patch(...canUpdateJoiningDate, validate(employeeValidation.updateJoiningDate), employeeController.updateJoining);

router
  .route('/:candidateId/resign-date')
  .patch(...canUpdateResignDate, validate(employeeValidation.updateResignDate), employeeController.updateResign);

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
  validate(employeeValidation.getCandidateSopStatus),
  employeeController.getSopStatus
);

router
  .route('/:candidateId')
  .get(...canRead, validate(employeeValidation.getCandidate), employeeController.get)
  .patch(...canRead, validate(employeeValidation.updateCandidate), employeeController.update)
  .delete(...canManage, validate(employeeValidation.deleteCandidate), employeeController.remove);

router
  .route('/documents/:candidateId')
  .get(...canRead, validate(employeeValidation.getDocuments), employeeController.getCandidateDocuments);

router
  .route('/documents/:candidateId/:documentIndex/download')
  .get(documentAuth, employeeController.downloadDocument);

router
  .route('/documents/verify/:candidateId/:documentIndex')
  .patch(...canManage, validate(employeeValidation.verifyDocument), employeeController.verifyDocumentStatus);

router
  .route('/documents/status/:candidateId')
  .get(...canRead, validate(employeeValidation.getDocumentStatus), employeeController.getCandidateDocumentStatus);

router
  .route('/share/:candidateId')
  .post(...canRead, validate(employeeValidation.shareCandidateProfile), employeeController.shareProfile);

router
  .route('/public/candidate/:candidateId')
  .get(employeeController.getPublicProfile);

export default router;
