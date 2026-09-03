import express from 'express';
import * as appController from '../../controllers/app.controller.js';

const router = express.Router();

/** Public — no auth. Used by the mobile app on launch to check for updates. */
router.get('/version', appController.getVersion);

export default router;
