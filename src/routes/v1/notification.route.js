/**
 * Notifications are intentionally protected by auth() only: every active user receives
 * their own notification stream; handlers scope all queries by req.user (see notification.controller).
 * There is no separate matrix permission to avoid blocking core app alerts for minimal roles.
 */
import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as notificationValidation from '../../validations/notification.validation.js';
import * as notificationController from '../../controllers/notification.controller.js';

const router = express.Router();

router.use(auth());

router.get('/admin/audit', requirePermissions('activityLogs.manage'), validate(notificationValidation.getAuditLog), notificationController.getAuditLog);
router.get('/', validate(notificationValidation.getNotifications), notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.get('/sse', notificationController.sse);
router.patch('/read-all', notificationController.markAllRead);

router
  .route('/:id/read')
  .patch(validate(notificationValidation.notificationIdParam), notificationController.markOneRead);

router
  .route('/:id')
  .delete(validate(notificationValidation.notificationIdParam), notificationController.remove);

export default router;
