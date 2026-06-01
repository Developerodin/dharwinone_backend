import express from 'express';
import auth from '../../middlewares/auth.js';
import requireExternalJobsAccess from '../../middlewares/requireExternalJobsAccess.js';
import externalJobController from '../../controllers/externalJob.controller.js';
import config from '../../config/config.js';

const router = express.Router();

router.post('/search', auth(), requireExternalJobsAccess(), externalJobController.search);
router.post('/save', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobController.save);
router.get('/saved', auth(), requireExternalJobsAccess(), externalJobController.listSaved);
router.delete(
  '/saved/:externalId',
  auth(),
  requireExternalJobsAccess({ requireManage: true }),
  externalJobController.unsave
);

router.post('/enrich', auth(), requireExternalJobsAccess(), externalJobController.enrichJob);

router.post('/hr-contacts', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobController.saveHrContact);
router.get('/hr-contacts', auth(), requireExternalJobsAccess(), externalJobController.listSavedHrContacts);
router.delete('/hr-contacts/:apolloId', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobController.deleteHrContact);

// Apollo webhook — verified by secret token in URL path (set APOLLO_WEBHOOK_SECRET in .env)
router.post('/webhook/apollo/:secret', (req, res, next) => {
  const expected = config.apollo.webhookSecret;
  if (expected && req.params.secret !== expected) {
    return res.status(403).send({ message: 'Forbidden' });
  }
  next();
}, externalJobController.apolloWebhook);

export default router;
