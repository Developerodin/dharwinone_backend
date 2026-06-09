import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions, { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as c from '../../controllers/orgSlot.controller.js';

const router = express.Router();

const canManage = [auth(), requirePermissions('structure.manage', { auditOnDeny: 'org.mutate.denied' })];
const canRead = [auth(), requireAnyOfPermissions('chart.read', 'structure.read', 'structure.manage')];

router.get('/vacant', ...canRead, c.listVacantForChart);
router.get('/', ...canRead, c.listOrgSlots);
router.post('/', ...canManage, c.createOrgSlot);
router.patch('/:slotId', ...canManage, c.updateOrgSlot);

export default router;
