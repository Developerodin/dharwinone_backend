import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as v from '../../validations/department.validation.js';
import * as c from '../../controllers/department.controller.js';

const router = express.Router();

const canReadDepartments = [
  auth(),
  requireAnyOfPermissions(
    'departments.read', 'departments.manage',
    'structure.read', 'structure.manage',
    'onboarding.read', 'onboarding.edit', 'onboarding.manage',
  ),
];

const canManageDepartments = [
  auth(),
  requireAnyOfPermissions('departments.manage', 'structure.manage'),
];

router
  .route('/')
  .get(...canReadDepartments, validate(v.getDepartments), c.getDepartments)
  .post(...canManageDepartments, validate(v.createDepartment), c.createDepartment);

router
  .route('/:departmentId')
  .patch(...canManageDepartments, validate(v.updateDepartment), c.updateDepartment)
  .delete(...canManageDepartments, validate(v.deactivateDepartment), c.deactivateDepartment);

router.patch('/:departmentId/reactivate', ...canManageDepartments, validate(v.reactivateDepartment), c.reactivateDepartment);
router.delete('/:departmentId/permanent', ...canManageDepartments, validate(v.deactivateDepartment), c.deleteDepartment);

export default router;
