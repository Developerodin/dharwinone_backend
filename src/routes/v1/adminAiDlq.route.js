import express from 'express';
import auth from '../../middlewares/auth.js';
import * as adminDlq from '../../controllers/adminAiDlq.controller.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const role = req.user?.role || req.user?.roleName;
  if (String(role).toLowerCase() === 'admin' || req.user?.isAdmin) return next();
  return res.status(403).json({ message: 'admin only' });
}

router.use(auth());
router.use(requireAdmin);

router.get('/dlq', adminDlq.listDlq);
router.post('/dlq/:jobId/replay', adminDlq.replayDlq);
router.delete('/dlq/:jobId', adminDlq.deleteDlq);
router.get('/queue/stats', adminDlq.queueStats);

export default router;
