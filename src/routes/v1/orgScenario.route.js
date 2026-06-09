import express from 'express';
import auth from '../../middlewares/auth.js';
import { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as c from '../../controllers/orgScenario.controller.js';

const router = express.Router({ mergeParams: true });

const canManage = [auth(), requireAnyOfPermissions('scenarios.manage', 'structure.manage')];
const canRead = [auth(), requireAnyOfPermissions('scenarios.read', 'scenarios.manage', 'structure.read', 'structure.manage')];

router.get('/', ...canRead, c.listScenarios);
router.post('/', ...canManage, c.createScenario);
router.post('/:scenarioId/clone', ...canManage, c.cloneScenario);
router.get('/:scenarioId/tree', ...canRead, c.getScenarioTree);
router.get('/:scenarioId/diff', ...canRead, c.diffScenario);
router.patch('/:scenarioId/units/:scenarioUnitId/reparent', ...canManage, c.reparentScenarioUnit);
router.patch('/:scenarioId/approve', ...canManage, c.approveScenario);
router.post('/:scenarioId/apply', ...canManage, c.applyScenario);

export default router;
