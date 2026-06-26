import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as v from '../../validations/offboardingSop.validation.js';
import controller from '../../controllers/offboardingSop.controller.js';

const router = express.Router();

const canManage = [auth(), requirePermissions('employees.manage')];

router
  .route('/config')
  .get(...canManage, controller.getConfig)
  .put(...canManage, validate(v.saveConfig), controller.putConfig);

router.get('/overview', ...canManage, controller.getOverview);

router.get('/:employeeId/status', ...canManage, validate(v.employeeIdParam), controller.getStatus);

router.post('/:employeeId/run/:stepKey', ...canManage, validate(v.runStep), controller.runStep);

export default router;
