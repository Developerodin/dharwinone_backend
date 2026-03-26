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
  // Impersonation
  IMPERSONATION_START: 'impersonation.start',
  IMPERSONATION_END: 'impersonation.end',
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
  JOB_CREATE: 'job.create',
  JOB_UPDATE: 'job.update',
  JOB_DELETE: 'job.delete',
  JOB_APPLICATION_CREATE: 'jobApplication.create',
  JOB_APPLICATION_UPDATE: 'jobApplication.update',
  JOB_APPLICATION_DELETE: 'jobApplication.delete',
  // Integration / admin settings (sensitive config surfaces)
  SETTINGS_BOLNA_CANDIDATE_AGENT_UPDATE: 'settings.bolnaCandidateAgent.update',
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
  JOB: 'Job',
  JOB_APPLICATION: 'JobApplication',
  BOLNA_CANDIDATE_AGENT_SETTINGS: 'BolnaCandidateAgentSettings',
};
