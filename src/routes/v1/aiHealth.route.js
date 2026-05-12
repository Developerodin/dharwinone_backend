import express from 'express';
import * as aiHealth from '../../controllers/aiHealth.controller.js';

const router = express.Router();
router.get('/ai', aiHealth.aiHealth);
export default router;
