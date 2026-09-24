import express from 'express';
import { verifyBolnaTool } from '../../middlewares/verifyBolnaTool.js';
import { aiToolsLimiter } from '../../middlewares/rateLimiter.js';
import * as aiToolsController from '../../controllers/aiTools.controller.js';

/** Bolna mid-call custom functions — no user auth; Bearer tool token (verifyBolnaTool). */
const router = express.Router();

router.use(aiToolsLimiter, verifyBolnaTool);

router.get('/interview-slots', aiToolsController.getInterviewSlots);
router.post('/interview-slots', aiToolsController.getInterviewSlots);
router.post('/interview-slots/hold', aiToolsController.holdInterviewSlot);
router.get('/interview-slots/hold', aiToolsController.holdInterviewSlot);

export default router;
