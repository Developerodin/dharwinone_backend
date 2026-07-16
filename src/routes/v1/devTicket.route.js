import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import { uploadImagesVideos } from '../../middlewares/upload.js';
import * as devTicketValidation from '../../validations/devTicket.validation.js';
import * as devTicketController from '../../controllers/devTicket.controller.js';

const router = express.Router();

const canView = [auth(), requirePermissions('devTickets.view')];

router.get('/analytics', ...canView, devTicketController.analytics);

router
  .route('/')
  .post(
    ...canView,
    uploadImagesVideos('attachments', 10),
    validate(devTicketValidation.createDevTicket),
    devTicketController.create
  )
  .get(...canView, validate(devTicketValidation.getDevTickets), devTicketController.list);

router.post('/bulk', ...canView, validate(devTicketValidation.bulkUpdate), devTicketController.bulk);

router
  .route('/:ticketId')
  .get(...canView, validate(devTicketValidation.getDevTicket), devTicketController.get)
  .patch(...canView, validate(devTicketValidation.updateDevTicket), devTicketController.update)
  .delete(...canView, validate(devTicketValidation.deleteDevTicket), devTicketController.remove);

router
  .route('/:ticketId/comments')
  .post(
    ...canView,
    uploadImagesVideos('attachments', 10),
    validate(devTicketValidation.addComment),
    devTicketController.addComment
  );

router.post('/:ticketId/watch', ...canView, validate(devTicketValidation.watchTicket), devTicketController.watch);
router.delete(
  '/:ticketId/watch',
  ...canView,
  validate(devTicketValidation.watchTicket),
  devTicketController.unwatch
);

router.post('/:ticketId/links', ...canView, validate(devTicketValidation.linkTicket), devTicketController.link);
router.delete(
  '/:ticketId/links/:linkId',
  ...canView,
  validate(devTicketValidation.unlinkTicket),
  devTicketController.unlink
);

router.post(
  '/:ticketId/reactions',
  ...canView,
  validate(devTicketValidation.addReaction),
  devTicketController.reactAdd
);
router.delete(
  '/:ticketId/reactions',
  ...canView,
  validate(devTicketValidation.removeReaction),
  devTicketController.reactRemove
);

export default router;
