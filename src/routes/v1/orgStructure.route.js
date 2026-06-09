import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as v from '../../validations/orgStructure.validation.js';
import * as c from '../../controllers/orgStructure.controller.js';

const router = express.Router();

const canReadTree = [auth(), requireAnyOfPermissions('chart.read', 'structure.read', 'structure.manage')];
const canReadUnits = [auth(), requireAnyOfPermissions('structure.read', 'structure.manage')];
const canExportStructure = [
  auth(),
  requirePermissions('structure.export', {
    auditOnDeny: 'org.mutate.denied',
    targetEntityType: 'OrgStructure',
  }),
];

router.get('/tree', ...canReadTree, c.getTree);
router.get('/search', ...canReadTree, c.searchChart);
router.get('/directory', auth(), requireAnyOfPermissions('directory.read', 'chart.read', 'structure.read', 'structure.manage'), c.getDirectory);
router.get('/coverage', ...canReadTree, c.getCoverage);
router.get('/export', ...canExportStructure, c.exportReport);
router.get('/employees', ...canReadUnits, c.getAssignableHeads);

router
  .route('/')
  .get(...canReadUnits, validate(v.getOrgUnits), c.getOrgUnits)
  .post(auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.createOrgUnit), c.createOrgUnit);

router.patch('/:orgUnitId/reparent', auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.reparentOrgUnit), c.reparentOrgUnit);
router.patch('/:orgUnitId/chart-reparent', auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.reparentOrgUnit), c.reparentFromChart);
router.patch('/:orgUnitId/head', auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.assignHead), c.assignHead);
router.patch('/:orgUnitId/reactivate', auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.reactivateOrgUnit), c.reactivateOrgUnit);
router.delete('/:orgUnitId/permanent', auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.deactivateOrgUnit), c.deleteOrgUnit);

router
  .route('/:orgUnitId')
  .patch(auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.updateOrgUnit), c.updateOrgUnit)
  .delete(auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' }), validate(v.deactivateOrgUnit), c.deactivateOrgUnit);

export default router;
