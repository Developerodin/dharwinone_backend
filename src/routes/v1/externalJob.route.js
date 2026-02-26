import express from 'express';
import auth from '../../middlewares/auth.js';
import requireAdministratorRole from '../../middlewares/requireAdministratorRole.js';
import externalJobController from '../../controllers/externalJob.controller.js';

const router = express.Router();

const adminAuth = [auth(), requireAdministratorRole()];

router.post('/search', adminAuth, externalJobController.search);
router.post('/save', adminAuth, externalJobController.save);
router.get('/saved', adminAuth, externalJobController.listSaved);
router.delete('/saved/:externalId', adminAuth, externalJobController.unsave);

export default router;
