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

router
  .route('/')
  .get(...canReadDepartments, validate(v.getDepartments), c.getDepartments)
  .post(auth(), requirePermissions('departments.manage'), validate(v.createDepartment), c.createDepartment);

router
  .route('/:departmentId')
  .patch(auth(), requirePermissions('departments.manage'), validate(v.updateDepartment), c.updateDepartment)
  .delete(auth(), requirePermissions('departments.manage'), validate(v.deactivateDepartment), c.deactivateDepartment);

router.patch('/:departmentId/reactivate', auth(), requirePermissions('departments.manage'), validate(v.reactivateDepartment), c.reactivateDepartment);
router.delete('/:departmentId/permanent', auth(), requirePermissions('departments.manage'), validate(v.deactivateDepartment), c.deleteDepartment);

export default router;
