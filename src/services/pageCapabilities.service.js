import {
  userIsAdmin,
  userIsSalesAgent,
  userHasCandidateRole,
  userHasEmployeeRole,
  userHasRecruiterRole,
} from '../utils/roleHelpers.js';

/**
 * Return role-specific page capabilities for dashboard routing.
 * The frontend uses this single payload to decide which dashboard variant to render,
 * which widgets to show, and which endpoints to call.
 *
 * Dashboard priority (first match wins): admin > recruiter > salesAgent > employee > candidate > default.
 * Employee (HRMS staff) and Candidate (ATS applicant) must stay separate — do not bucket both under candidate.
 *
 * @param {import('../models/user.model.js').default} user
 * @returns {Promise<{ dashboardType: string, widgets: string[], allowedEndpoints: string[], permissionsVersion: string }>}
 */
const getPageCapabilities = async (user) => {
  const [isAdmin, isSalesAgent, isEmployee, isCandidate, isRecruiter] = await Promise.all([
    userIsAdmin(user),
    userIsSalesAgent(user),
    userHasEmployeeRole(user),
    userHasCandidateRole(user),
    userHasRecruiterRole(user),
  ]);

  const permissionsVersion = String(user?.updatedAt?.getTime() ?? Date.now());

  if (isAdmin || user?.platformSuperUser) {
    return {
      dashboardType: 'admin',
      widgets: [
        'tenantAnalytics',
        'allCandidates',
        'allApplications',
        'allJobs',
        'allAttendance',
        'allRecordings',
        'referralOverview',
        'hrmsMetrics',
      ],
      allowedEndpoints: [
        '/v1/ats/analytics',
        '/v1/ats/job-applications',
        '/v1/ats/employees',
        '/v1/jobs',
        '/v1/recordings',
        '/v1/referral-leads',
        '/v1/attendance',
        '/v1/dashboard',
      ],
      permissionsVersion,
    };
  }

  if (isRecruiter) {
    return {
      dashboardType: 'recruiter',
      widgets: ['ownedJobs', 'ownedApplications', 'interviewQueue', 'recruiterActivity'],
      allowedEndpoints: [
        '/v1/ats/job-applications',
        '/v1/jobs',
        '/v1/ats/analytics/scoped',
        '/v1/recordings',
      ],
      permissionsVersion,
    };
  }

  if (isSalesAgent) {
    return {
      dashboardType: 'salesAgent',
      widgets: ['referralLeads', 'referralStats', 'assignedApplicants', 'referralFunnel'],
      allowedEndpoints: [
        '/v1/referral-leads',
        '/v1/ats/job-applications',
        '/v1/ats/analytics/scoped',
      ],
      permissionsVersion,
    };
  }

  if (isEmployee) {
    return {
      dashboardType: 'employee',
      widgets: [
        'myAttendance',
        'myTasks',
        'myProjects',
        'myMeetings',
        'profileCompletion',
        'upcomingHolidays',
      ],
      allowedEndpoints: [
        '/v1/training/attendance',
        '/v1/tasks',
        '/v1/projects',
        '/v1/meetings',
        '/v1/dashboard',
        '/v1/notifications',
      ],
      permissionsVersion,
    };
  }

  if (isCandidate) {
    return {
      dashboardType: 'candidate',
      widgets: [
        'myApplications',
        'myInterviews',
        'myAttendance',
        'myDocuments',
        'profileCompletion',
        'nextAction',
      ],
      allowedEndpoints: [
        '/v1/ats/job-applications/my',
        '/v1/attendance/my',
        '/v1/jobs',
      ],
      permissionsVersion,
    };
  }

  return {
    dashboardType: 'default',
    widgets: ['profileCompletion'],
    allowedEndpoints: ['/v1/jobs'],
    permissionsVersion,
  };
};

export { getPageCapabilities };
