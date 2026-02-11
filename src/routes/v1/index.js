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
import docsRoute from './docs.route.js';
import config from '../../config/config.js';

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
    path: '/upload',
    route: uploadRoute,
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
