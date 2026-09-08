/**
 * Activity log action constants for audit trails.
 * Use these when creating log entries so logs are queryable and consistent.
 */
export const ActivityActions = {
  // Roles
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',
  // Users
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  USER_DISABLE: 'user.disable',
  /** Successful sign-in (e.g. POST /auth/login with email/password) */
  USER_LOGIN: 'user.login',
  /** Session ended via POST /auth/logout (refresh token revoked) */
  USER_LOGOUT: 'user.logout',
  // Impersonation
  IMPERSONATION_START: 'impersonation.start',
  IMPERSONATION_END: 'impersonation.end',
  /** Platform super user invited a user to a consent-based live camera support session */
  SUPPORT_CAMERA_INVITE: 'supportCamera.invite',
  // Categories
  CATEGORY_CREATE: 'category.create',
  CATEGORY_UPDATE: 'category.update',
  CATEGORY_DELETE: 'category.delete',
  // Students
  STUDENT_UPDATE: 'student.update',
  STUDENT_DELETE: 'student.delete',
  // Mentors
  MENTOR_UPDATE: 'mentor.update',
  MENTOR_DELETE: 'mentor.delete',
  // Student Courses
  STUDENT_COURSE_START: 'student.course.start',
  STUDENT_COURSE_COMPLETE: 'student.course.complete',
  STUDENT_QUIZ_ATTEMPT: 'student.quiz.attempt',
  CERTIFICATE_ISSUED: 'certificate.issued',
  // Attendance
  ATTENDANCE_PUNCH_IN: 'attendance.punchIn',
  ATTENDANCE_PUNCH_OUT: 'attendance.punchOut',
  ATTENDANCE_PUNCH_OUT_BY_ADMIN: 'attendance.punchOutByAdmin',
  ATTENDANCE_AUTO_PUNCH_OUT: 'attendance.autoPunchOut',
  // ATS — candidates, jobs, applications
  CANDIDATE_CREATE: 'candidate.create',
  CANDIDATE_UPDATE: 'candidate.update',
  CANDIDATE_DELETE: 'candidate.delete',
  /** Admin overrode a locked (offer-sourced) compensation snapshot. metadata: { before, after }. */
  CANDIDATE_COMPENSATION_OVERRIDE: 'candidate.compensation.override',
  CANDIDATE_ONBOARDING_SHARE: 'candidate.onboardingShare',
  CANDIDATE_PROFILE_SHARE: 'candidate.profile.share',
  CANDIDATE_EXPORT: 'candidate.export',
  CANDIDATE_IMPORT: 'candidate.import',
  JOB_CREATE: 'job.create',
  JOB_CREATE_FROM_TEMPLATE: 'job.createFromTemplate',
  JOB_UPDATE: 'job.update',
  JOB_DELETE: 'job.delete',
  JOB_SHARE: 'job.share',
  JOB_EXPORT: 'job.export',
  JOB_IMPORT: 'job.import',
  JOB_TEMPLATE_CREATE: 'job.template.create',
  JOB_TEMPLATE_UPDATE: 'job.template.update',
  JOB_TEMPLATE_DELETE: 'job.template.delete',
  JOB_BOOKMARK_ADD: 'job.bookmark.add',
  JOB_BOOKMARK_DELETE: 'job.bookmark.delete',
  JOB_APPLICATION_CREATE: 'jobApplication.create',
  JOB_APPLICATION_UPDATE: 'jobApplication.update',
  JOB_APPLICATION_DELETE: 'jobApplication.delete',
  REFERRAL_LEADS_EXPORT: 'referralLeads.export',
  REFERRAL_ATTRIBUTION_OVERRIDE: 'referral.attribution.override',
  /** Referrer id stored as actor; metadata includes claimStage (public_register, onboard_invite, job_apply*). */
  REFERRAL_CLAIM: 'referral.claim',
  /** HMAC ref= link minted (POST /referral-link). entityId = jti. */
  REFERRAL_LINK_ISSUED: 'referral.link.issued',
  /** Referral candidate moved to `applied` for a job (incl. when attribution was already set). */
  REFERRAL_JOB_APPLIED: 'referral.job.applied',
  /** Referred candidate User became active (pending → active) while linked Employee has a referrer. */
  REFERRAL_CANDIDATE_ACTIVATED: 'referral.candidate.activated',
  /** Referred candidate’s placement status set to Joined (hire); metadata includes placementId, jobId, referrerUserId. */
  REFERRAL_HIRE_JOINED: 'referral.hire.joined',
  // Support Tickets
  TICKET_CREATE: 'ticket.create',
  TICKET_STATUS_CHANGE: 'ticket.statusChange',
  TICKET_PRIORITY_CHANGE: 'ticket.priorityChange',
  TICKET_ASSIGN: 'ticket.assign',
  TICKET_COMMENT: 'ticket.comment',
  TICKET_DELETE: 'ticket.delete',
  // Integration / admin settings (sensitive config surfaces)
  SETTINGS_BOLNA_CANDIDATE_AGENT_UPDATE: 'settings.bolnaCandidateAgent.update',
  /** Admin bought a phone number from Plivo (real paid action). metadata: { number, type, monthlyRentalRate }. */
  PHONE_NUMBER_PURCHASE: 'phoneNumber.purchase',
  /** Placed an outbound click-to-call bridge via Plivo (billable). metadata: { toNumber, callerId }. */
  PHONE_CALL_PLACE: 'phoneNumber.callPlace',
  // Organization — org units
  ORG_UNIT_CREATE: 'orgUnit.create',
  ORG_UNIT_UPDATE: 'orgUnit.update',
  ORG_UNIT_REPARENT: 'orgUnit.reparent',
  ORG_UNIT_HEAD_ASSIGN: 'orgUnit.headAssign',
  ORG_UNIT_HEAD_CLEAR: 'orgUnit.headClear',
  ORG_UNIT_REORDER: 'orgUnit.reorder',
  ORG_UNIT_DEACTIVATE: 'orgUnit.deactivate',
  ORG_UNIT_REACTIVATE: 'orgUnit.reactivate',
  ORG_UNIT_DELETE: 'orgUnit.delete',
  // Organization — departments
  DEPARTMENT_CREATE: 'department.create',
  DEPARTMENT_UPDATE: 'department.update',
  DEPARTMENT_DEACTIVATE: 'department.deactivate',
  DEPARTMENT_REACTIVATE: 'department.reactivate',
  DEPARTMENT_DELETE: 'department.delete',
  // Organization — structure export
  ORG_STRUCTURE_EXPORT: 'orgStructure.export',
  // Organization — employee department assignment
  EMPLOYEE_DEPARTMENT_ASSIGN: 'employee.departmentAssign',
  EMPLOYEE_AGENT_ASSIGN: 'employee.agent.assign',
  EMPLOYEE_RECRUITER_ASSIGN: 'employee.recruiter.assign',
  EMPLOYEE_COMPANY_EMAIL_ASSIGN: 'employee.companyEmail.assign',
  EMPLOYEE_JOINING_DATE_UPDATE: 'employee.joiningDate.update',
  EMPLOYEE_RESIGN_DATE_UPDATE: 'employee.resignDate.update',
  EMPLOYEE_SHIFT_ASSIGN: 'employee.shift.assign',
  EMPLOYEE_WEEK_OFF_UPDATE: 'employee.weekOff.update',
  EMPLOYEE_DOCUMENT_REQUEST: 'employee.document.request',
  EMPLOYEE_DOCUMENT_UPLOAD: 'employee.document.upload',
  EMPLOYEE_DOCUMENT_VERIFY: 'employee.document.verify',
  EMPLOYEE_DOCUMENT_DELETE: 'employee.document.delete',
  EMPLOYEE_DOCUMENT_DOWNLOAD: 'employee.document.download',
  EMPLOYEE_SALARY_SLIP_ADD: 'employee.salarySlip.add',
  EMPLOYEE_SALARY_SLIP_UPDATE: 'employee.salarySlip.update',
  EMPLOYEE_SALARY_SLIP_DELETE: 'employee.salarySlip.delete',
  EMPLOYEE_SALARY_SLIP_DOWNLOAD: 'employee.salarySlip.download',
  EMPLOYEE_NOTE_ADD: 'employee.note.add',
  EMPLOYEE_FEEDBACK_ADD: 'employee.feedback.add',
  // Internal mobility — existing employee transferred to a new role post-interview
  EMPLOYEE_TRANSFER: 'employee.transfer',
  // Interviews
  INTERVIEW_CREATE: 'interview.create',
  INTERVIEW_UPDATE: 'interview.update',
  INTERVIEW_DELETE: 'interview.delete',
  INTERVIEW_INVITATION_RESEND: 'interview.invitation.resend',
  INTERVIEW_MOVE_TO_PREBOARDING: 'interview.moveToPreboarding',
  INTERVIEW_EXPORT: 'interview.export',
  INTERVIEW_RECORDING_VIEW: 'interview.recording.view',
  INTERVIEW_RESULT_UPDATE: 'interview.result.update',
  // Offers & placement
  OFFER_CREATE: 'offer.create',
  OFFER_UPDATE: 'offer.update',
  OFFER_DELETE: 'offer.delete',
  OFFER_STATUS_CHANGE: 'offer.statusChange',
  OFFER_LETTER_GENERATE: 'offer.letter.generate',
  OFFER_SHARE: 'offer.share',
  PLACEMENT_STATUS_CHANGE: 'placement.statusChange',
  PLACEMENT_COMPENSATION_CHANGE: 'placement.compensationChange',
  PLACEMENT_PREBOARDING_GATE_BYPASS: 'placement.preboardingGateBypass',
  PLACEMENT_TASK_UPDATE: 'placement.task.update',
  PLACEMENT_JOINING_DATE_UPDATE: 'placement.joiningDate.update',
  // Referrals & external jobs
  REFERRAL_SALES_AGENT_ASSIGN: 'referral.salesAgent.assign',
  REFERRAL_SALES_AGENT_CHANGE: 'referral.salesAgent.change',
  REFERRAL_SALES_AGENT_REVOKE: 'referral.salesAgent.revoke',
  REFERRAL_BACKFILL: 'referral.backfill',
  EXTERNAL_JOB_SAVE: 'externalJob.save',
  EXTERNAL_JOB_DELETE: 'externalJob.delete',
  EXTERNAL_JOB_HR_CONTACT_SAVE: 'externalJob.hrContact.save',
  EXTERNAL_JOB_HR_CONTACT_DELETE: 'externalJob.hrContact.delete',
  EXTERNAL_JOB_AUTO_FETCH: 'externalJob.autoFetch',
  /** Denied org write/export attempt (allowlisted metadata only). */
  ORG_MUTATE_DENIED: 'org.mutate.denied',
  // Organization — scenario sandbox
  ORG_SCENARIO_CREATE: 'orgScenario.create',
  ORG_SCENARIO_APPLY: 'orgScenario.apply',
  ORG_SCENARIO_APPROVE: 'orgScenario.approve',
  // Organization — headcount slots
  ORG_SLOT_CREATE: 'orgSlot.create',
  ORG_SLOT_UPDATE: 'orgSlot.update',
  // Communication contact discovery
  /** Exact-email contact lookup. Recorded on hit AND miss so the log is not an oracle. Spec §6. */
  CONTACT_LOOKUP: 'contact.lookup',
};

export const EntityTypes = {
  ROLE: 'Role',
  USER: 'User',
  IMPERSONATION: 'Impersonation',
  CATEGORY: 'Category',
  STUDENT: 'Student',
  MENTOR: 'Mentor',
  STUDENT_COURSE_PROGRESS: 'StudentCourseProgress',
  STUDENT_QUIZ_ATTEMPT: 'StudentQuizAttempt',
  CERTIFICATE: 'Certificate',
  ATTENDANCE: 'Attendance',
  CANDIDATE: 'Candidate',
  /** Referral link issuance rows (entityId = jti) */
  REFERRAL: 'Referral',
  JOB: 'Job',
  JOB_APPLICATION: 'JobApplication',
  BOLNA_CANDIDATE_AGENT_SETTINGS: 'BolnaCandidateAgentSettings',
  PHONE_NUMBER: 'PhoneNumber',
  SUPPORT_TICKET: 'SupportTicket',
  ORG_UNIT: 'OrgUnit',
  DEPARTMENT: 'Department',
  ORG_STRUCTURE: 'OrgStructure',
  EMPLOYEE: 'Employee',
  ORG_SCENARIO: 'OrgScenario',
  ORG_SLOT: 'OrgSlot',
  /** Exact-email lookup audit rows (entityId = sha256 of the normalised queried email) */
  CONTACT_LOOKUP: 'ContactLookup',
  MEETING: 'Meeting',
  OFFER: 'Offer',
  PLACEMENT: 'Placement',
  EXTERNAL_JOB: 'ExternalJob',
};
