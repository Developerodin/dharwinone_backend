import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as v from '../../validations/contact.validation.js';
import * as ctrl from '../../controllers/contact.controller.js';

const router = express.Router();

router.route('/')
  .get(auth(), requirePermissions('contacts.view'), validate(v.getContacts), ctrl.list)
  .post(auth(), requirePermissions('contacts.create'), validate(v.createContact), ctrl.create);

router.route('/:contactId')
  .get(auth(), requirePermissions('contacts.view'), validate(v.getContact), ctrl.get)
  .patch(auth(), requirePermissions('contacts.edit'), validate(v.updateContact), ctrl.update)
  .delete(auth(), requirePermissions('contacts.delete'), validate(v.deleteContact), ctrl.remove);

export default router;
