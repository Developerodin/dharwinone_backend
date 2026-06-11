import express from 'express';
import auth from '../../middlewares/auth.js';
import { requireAnyOfPermissions } from '../../middlewares/requirePermissions.js';
import * as c from '../../controllers/orgScenario.controller.js';

const router = express.Router({ mergeParams: true });

// Scenarios are gated by their own permission only. Structure grants do NOT cross-grant
// scenario access (a role must explicitly hold organization.scenarios:* to see/edit reorg drafts).
const canManage = [auth(), requireAnyOfPermissions('scenarios.manage')];
const canRead = [auth(), requireAnyOfPermissions('scenarios.read', 'scenarios.manage')];

router.get('/', ...canRead, c.listScenarios);
router.post('/', ...canManage, c.createScenario);
router.post('/:scenarioId/clone', ...canManage, c.cloneScenario);
router.get('/:scenarioId/tree', ...canRead, c.getScenarioTree);
router.get('/:scenarioId/diff', ...canRead, c.diffScenario);
router.patch('/:scenarioId/units/:scenarioUnitId/reparent', ...canManage, c.reparentScenarioUnit);
router.patch('/:scenarioId/approve', ...canManage, c.approveScenario);
router.post('/:scenarioId/apply', ...canManage, c.applyScenario);
router.delete('/:scenarioId', ...canManage, c.deleteScenario);

export default router;
