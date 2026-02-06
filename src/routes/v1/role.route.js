import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as roleValidation from '../../validations/role.validation.js';
import * as roleController from '../../controllers/role.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('roles.manage'), validate(roleValidation.createRole), roleController.createRole)
  .get(auth(), requirePermissions('roles.read'), validate(roleValidation.getRoles), roleController.getRoles);

router
  .route('/:roleId')
  .get(auth(), requirePermissions('roles.read'), validate(roleValidation.getRole), roleController.getRole)
  .patch(auth(), requirePermissions('roles.manage'), validate(roleValidation.updateRole), roleController.updateRole)
  .delete(auth(), requirePermissions('roles.manage'), validate(roleValidation.deleteRole), roleController.deleteRole);

export default router;
