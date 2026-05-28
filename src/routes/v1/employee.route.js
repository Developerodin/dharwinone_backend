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
import requireFeatureFlag from '../../middlewares/requireFeatureFlag.js';
import { FEATURE_FLAG_NAME } from '../../constants/salesAgentAttribution.js';

const router = express.Router();

/** PR2: employee CRUD/list — employees.* primary, candidates.* legacy backstop. */
const canReadEmployees = [auth(), requireAnyOfPermissions('candidates.read', 'employees.read')];
const canManageEmployees = [auth(), requireAnyOfPermissions('candidates.manage', 'employees.manage')];
/** Referral / pre-hire pipeline — candidates.* only (employees-only roles must not leak here). */
const canReadCandidatesOnly = [auth(), requirePermissions('candidates.read')];
const canManageCandidatesOnly = [auth(), requirePermissions('candidates.manage')];
const canUpdateJoiningDate = [
  auth(),
  requireAnyOfPermissions('candidates.manage', 'onboarding.manage', 'employees.manage'),
];
const canUpdateResignDate = [
  auth(),
  requireAnyOfPermissions('candidates.manage', 'employees.manage'),
];
const canManageSalesAgentAttribution = [
  auth(),
  requirePermissions('candidates.manageSalesAgentAttribution'),
  requireFeatureFlag(FEATURE_FLAG_NAME),
];
const canRevokeSalesAgentAttribution = [
  auth(),
  requirePermissions('candidates.revokeSalesAgentAttribution'),
  requireFeatureFlag(FEATURE_FLAG_NAME),
];
const canReadSalesAgentAttribution = [auth(), requirePermissions('candidates.read'), requireFeatureFlag(FEATURE_FLAG_NAME)];

router
  .route('/')
  .post(...canManageEmployees, validate(employeeValidation.createCandidate), employeeController.create)
  .get(...canReadEmployees, validate(employeeValidation.getCandidates), employeeController.list);

/** Referral leads (ATS) — list must be before /:candidateId */
router.get(
  '/referral-leads',
  ...canReadCandidatesOnly,
  validate(employeeValidation.getReferralLeads),
  employeeController.listReferralLeadsHandler
);
router.get(
  '/referral-leads/stats',
  ...canReadCandidatesOnly,
  validate(employeeValidation.getReferralLeadsStats),
  employeeController.getReferralLeadsStatsHandler
);
router.get(
  '/referral-leads/export',
  ...canReadCandidatesOnly,
  validate(employeeValidation.getReferralLeadsStats),
  employeeController.exportReferralLeadsHandler
);
router.post(
  '/referral-link',
  ...canReadCandidatesOnly,
  validate(employeeValidation.postReferralLinkToken),
  employeeController.postReferralLinkToken
);
router.post(
  '/referral-leads/:candidateId/override',
  ...canManageCandidatesOnly,
  validate(employeeValidation.postReferralAttributionOverride),
  employeeController.postReferralAttributionOverride
);
router.get(
  '/referral-leads/:candidateId/attribution-override-history',
  ...canReadCandidatesOnly,
  validate(employeeValidation.getReferralAttributionOverrideHistory),
  employeeController.getReferralAttributionOverrideHistoryHandler
);
router.post(
  '/referral-leads/:candidateId/sales-agent',
  ...canManageSalesAgentAttribution,
  validate(employeeValidation.postSalesAgentAssign),
  employeeController.postSalesAgentAssignHandler
);
router.patch(
  '/referral-leads/:candidateId/sales-agent',
  ...canManageSalesAgentAttribution,
  validate(employeeValidation.patchSalesAgentChange),
  employeeController.patchSalesAgentChangeHandler
);
router.delete(
  '/referral-leads/:candidateId/sales-agent',
  ...canRevokeSalesAgentAttribution,
  validate(employeeValidation.deleteSalesAgent),
  employeeController.deleteSalesAgentHandler
);
router.get(
  '/referral-leads/:candidateId/sales-agent-history',
  ...canReadSalesAgentAttribution,
  validate(employeeValidation.getSalesAgentHistory),
  employeeController.getSalesAgentHistoryHandler
);
router.patch(
  '/referral-leads/:candidateId/attribution-job',
  ...canManageSalesAgentAttribution,
  validate(employeeValidation.patchAttributionJob),
  employeeController.patchAttributionJobHandler
);
router.post(
  '/referral-leads/backfill',
  ...canManageSalesAgentAttribution,
  validate(employeeValidation.postReferralBackfill),
  employeeController.postReferralBackfillHandler
);

/** Current user's own candidate – auth only (for role 'user' from share-candidate-form). Must be before /:candidateId. */
router
  .route('/me')
  .get(auth(), employeeController.getMyCandidate)
  .patch(auth(), validate(employeeValidation.updateMyCandidate), employeeController.updateMyCandidate);

/** Job matches for current user's candidate profile — auth only, no candidates.read required. */
router.get('/me/matching-jobs', auth(), employeeController.getMyMatchingJobsHandler);

/** All Agent-role users for ATS candidate filter (checklist) — candidates.read */
router.get(
  '/agents',
  ...canReadEmployees,
  validate(employeeValidation.listAgentsForFilter),
  employeeController.listAgentsForFilter
);

/** Per-agent assigned counts + unassigned (org-wide for employment scope) — candidates.manage */
router.get(
  '/agent-assignment-summary',
  ...canManageEmployees,
  validate(employeeValidation.getAgentAssignmentSummary),
  employeeController.getAgentAssignmentSummaryHandler
);

/** Training students ↔ agents — must be before /:candidateId */
router.get(
  '/student-agent-assignments',
  ...canManageEmployees,
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
  ...canManageEmployees,
  validate(employeeValidation.getSopOpenOverview),
  employeeController.getSopOpenOverview
);

/** Queue in-app SOP notifications for candidates with open steps (all users with candidates.manage receive them). */
router.post('/sop-reminders/dispatch', ...canManageEmployees, employeeController.postSopRemindersDispatch);

router
  .route('/export')
  .post(...canManageEmployees, validate(employeeValidation.exportAllCandidates), employeeController.exportAll);

router
  .route('/import/excel')
  .post(...canManageEmployees, uploadSingle('file'), employeeController.importExcel);

router
  .route('/salary-slips/:candidateId')
  .post(...canReadEmployees, validate(employeeValidation.addSalarySlip), employeeController.addSalarySlip);

/** Salary slip download: auth only (like /documents/.../download). Owner access is enforced in getSalarySlipDownloadUrl — not candidates.read (so profile owners can view their own slips). */
router
  .route('/salary-slips/:candidateId/:salarySlipIndex')
  .get(documentAuth, validate(employeeValidation.downloadSalarySlip), employeeController.downloadSalarySlip)
  .patch(...canReadEmployees, validate(employeeValidation.updateSalarySlip), employeeController.updateSalarySlip)
  .delete(...canReadEmployees, validate(employeeValidation.deleteSalarySlip), employeeController.deleteSalarySlip);

router
  .route('/:candidateId/resend-verification-email')
  .post(...canManageEmployees, validate(employeeValidation.resendVerificationEmail), employeeController.resendVerificationEmail);

router
  .route('/:candidateId/export')
  .post(...canReadEmployees, validate(employeeValidation.exportCandidate), employeeController.exportProfile);

router
  .route('/:candidateId/notes')
  .post(...canReadEmployees, validate(employeeValidation.addRecruiterNote), employeeController.addNote);

router
  .route('/:candidateId/feedback')
  .post(...canReadEmployees, validate(employeeValidation.addRecruiterFeedback), employeeController.addFeedback);

router
  .route('/:candidateId/assign-recruiter')
  .post(...canManageEmployees, validate(employeeValidation.assignRecruiter), employeeController.assignRecruiter);

router
  .route('/:candidateId/assign-agent')
  .post(...canManageEmployees, validate(employeeValidation.assignAgent), employeeController.assignAgent);

router
  .route('/:candidateId/company-assigned-email')
  .post(
    ...canManageEmployees,
    validate(employeeValidation.assignCompanyAssignedEmail),
    employeeController.assignCompanyAssignedEmail
  );

router
  .route('/week-off')
  .post(...canManageEmployees, validate(employeeValidation.updateWeekOff), employeeController.updateWeekOff);

router
  .route('/:candidateId/week-off')
  .get(...canReadEmployees, validate(employeeValidation.getWeekOff), employeeController.getWeekOff);

router
  .route('/assign-shift')
  .post(...canManageEmployees, validate(employeeValidation.assignShift), employeeController.assignShift);

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
  .get(...canReadEmployees, validate(employeeValidation.getCandidate), employeeController.get)
  .patch(...canReadEmployees, validate(employeeValidation.updateCandidate), employeeController.update)
  .delete(...canManageEmployees, validate(employeeValidation.deleteCandidate), employeeController.remove);

router
  .route('/documents/:candidateId')
  .get(...canReadEmployees, validate(employeeValidation.getDocuments), employeeController.getCandidateDocuments);

router
  .route('/documents/:candidateId/:documentIndex/download')
  .get(documentAuth, employeeController.downloadDocument);

router
  .route('/documents/verify/:candidateId/:documentIndex')
  .patch(...canManageEmployees, validate(employeeValidation.verifyDocument), employeeController.verifyDocumentStatus);

router
  .route('/documents/status/:candidateId')
  .get(...canReadEmployees, validate(employeeValidation.getDocumentStatus), employeeController.getCandidateDocumentStatus);

router
  .route('/share/:candidateId')
  .post(...canReadEmployees, validate(employeeValidation.shareCandidateProfile), employeeController.shareProfile);

router
  .route('/public/candidate/:candidateId')
  .get(employeeController.getPublicProfile);

/** Job fit score: compare candidate skills against a job's skillRequirements */
router.get(
  '/:candidateId/job-fit',
  ...canReadEmployees,
  employeeController.getJobFitHandler
);

export default router;
