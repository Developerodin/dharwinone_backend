import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as v from '../../validations/orgStructure.validation.js';
import * as c from '../../controllers/orgStructure.controller.js';

const router = express.Router();

const canReadTree = [auth(), requireAnyOfPermissions('chart.read', 'structure.read', 'structure.manage')];
const canReadUnits = [auth(), requireAnyOfPermissions('structure.read', 'structure.manage')];

router.get('/tree', ...canReadTree, c.getTree);
router.get('/coverage', ...canReadTree, c.getCoverage);
router.get('/export', ...canReadTree, c.exportReport);

router
  .route('/')
  .get(...canReadUnits, c.getOrgUnits)
  .post(auth(), requirePermissions('structure.manage'), validate(v.createOrgUnit), c.createOrgUnit);

router.patch('/:orgUnitId/reparent', auth(), requirePermissions('structure.manage'), validate(v.reparentOrgUnit), c.reparentOrgUnit);
router.patch('/:orgUnitId/head', auth(), requirePermissions('structure.manage'), validate(v.assignHead), c.assignHead);

router
  .route('/:orgUnitId')
  .patch(auth(), requirePermissions('structure.manage'), validate(v.updateOrgUnit), c.updateOrgUnit)
  .delete(auth(), requirePermissions('structure.manage'), validate(v.deactivateOrgUnit), c.deactivateOrgUnit);

export default router;
