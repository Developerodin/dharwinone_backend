import express from 'express';
import authRoute from './auth.route.js';
import userRoute from './user.route.js';
import roleRoute from './role.route.js';
import publicRoute from './public.route.js';
import activityLogRoute from './activityLog.route.js';
import categoryRoute from './category.route.js';
import studentRoute from './student.route.js';
import mentorRoute from './mentor.route.js';
import uploadRoute from './upload.route.js';
import trainingModuleRoute from './trainingModule.route.js';
import studentCourseRoute from './studentCourse.route.js';
import studentQuizRoute from './studentQuiz.route.js';
import certificateRoute from './certificate.route.js';
import evaluationRoute from './evaluation.route.js';
import analyticsRoute from './analytics.route.js';
import attendanceRoute from './attendance.route.js';
import holidayRoute from './holiday.route.js';
import studentGroupRoute from './studentGroup.route.js';
import shiftRoute from './shift.route.js';
import leaveRequestRoute from './leaveRequest.route.js';
import backdatedAttendanceRequestRoute from './backdatedAttendanceRequest.route.js';
import candidateRoute from './candidate.route.js';
import jobRoute from './job.route.js';
import recruiterActivityRoute from './recruiterActivity.route.js';
import recruiterExcelRoute from './recruiterExcel.route.js';
import docsRoute from './docs.route.js';
import config from '../../config/config.js';
import blogRoute from './blog.route.js';
import livekitRoute from './livekit.route.js';
import meetingRoute from './meeting.route.js';
import atsAnalyticsRoute from './atsAnalytics.route.js';
import jobApplicationRoute from './jobApplication.route.js';
import offerRoute from './offer.route.js';
import placementRoute from './placement.route.js';
import bolnaRoute from './bolna.route.js';
import webhookRoute from './webhook.route.js';

const router = express.Router();

const defaultRoutes = [
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/users',
    route: userRoute,
  },
  {
    path: '/roles',
    route: roleRoute,
  },
  {
    path: '/public',
    route: publicRoute,
  },
  {
    path: '/activity-logs',
    route: activityLogRoute,
  },
  {
    path: '/training/categories',
    route: categoryRoute,
  },
  {
    path: '/training/students',
    route: studentRoute,
  },
  {
    path: '/training/mentors',
    route: mentorRoute,
  },
  {
    path: '/training/modules',
    route: trainingModuleRoute,
  },
  {
    path: '/training/evaluation',
    route: evaluationRoute,
  },
  {
    path: '/training/analytics',
    route: analyticsRoute,
  },
  {
    path: '/training/attendance',
    route: attendanceRoute,
  },
  {
    path: '/holidays',
    route: holidayRoute,
  },
  {
    path: '/student-groups',
    route: studentGroupRoute,
  },
  {
    path: '/shifts',
    route: shiftRoute,
  },
  {
    path: '/leave-requests',
    route: leaveRequestRoute,
  },
  {
    path: '/backdated-attendance-requests',
    route: backdatedAttendanceRequestRoute,
  },
  {
    path: '/candidates',
    route: candidateRoute,
  },
  {
    path: '/jobs',
    route: jobRoute,
  },
  {
    path: '/recruiter-activities',
    route: recruiterActivityRoute,
  },
  {
    path: '/recruiters',
    route: recruiterExcelRoute,
  },
  {
    path: '/ats/analytics',
    route: atsAnalyticsRoute,
  },
  {
    path: '/job-applications',
    route: jobApplicationRoute,
  },
  {
    path: '/offers',
    route: offerRoute,
  },
  {
    path: '/placements',
    route: placementRoute,
  },
  {
    path: '/training/students',
    route: studentCourseRoute,
  },
  {
    path: '/training/students',
    route: studentQuizRoute,
  },
  {
    path: '/certificates',
    route: certificateRoute,
  },
  {
    path: '/upload',
    route: uploadRoute,
  },
  {
    path: '/blog',
    route: blogRoute,
  },
  {
    path: '/livekit',
    route: livekitRoute,
  },
  {
    path: '/bolna',
    route: bolnaRoute,
  },
  {
    path: '/webhooks',
    route: webhookRoute,
  },
  {
    path: '/meetings',
    route: meetingRoute,
  },
];

const devRoutes = [
  // routes available only in development mode
  {
    path: '/docs',
    route: docsRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

/* istanbul ignore next */
if (config.env === 'development') {
  devRoutes.forEach((route) => {
    router.use(route.path, route.route);
  });
}

export default router;
