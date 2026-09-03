import express from 'express';
import auth from '../../middlewares/auth.js';
import requireExternalJobsAccess from '../../middlewares/requireExternalJobsAccess.js';
import validate from '../../middlewares/validate.js';
import * as externalJobValidation from '../../validations/externalJob.validation.js';
import externalJobController from '../../controllers/externalJob.controller.js';
import externalJobAutoFetchController from '../../controllers/externalJobAutoFetch.controller.js';
import config from '../../config/config.js';

const router = express.Router();

// Auto-fetch: admin-managed recurring sync. Manage-level access only (same gate
// as save/delete) -- regular external-jobs.read users cannot configure or run it.
router.get('/auto-fetch', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobAutoFetchController.getConfig);
router.post('/auto-fetch', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobAutoFetchController.saveConfig);
router.patch('/auto-fetch', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobAutoFetchController.patchConfig);
router.post('/auto-fetch/run', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobAutoFetchController.runNow);
router.get('/auto-fetch/runs', auth(), requireExternalJobsAccess({ requireManage: true }), externalJobAutoFetchController.listRuns);

router.post('/search', auth(), requireExternalJobsAccess(), validate(externalJobValidation.searchExternalJobs), externalJobController.search);
router.post('/save', auth(), requireExternalJobsAccess({ requireManage: true }), validate(externalJobValidation.saveExternalJob), externalJobController.save);
// Registered before the parameterised routes below so `ids` is never read as an id.
router.get('/saved/ids', auth(), requireExternalJobsAccess(), externalJobController.listSavedIds);
router.get('/saved', auth(), requireExternalJobsAccess(), validate(externalJobValidation.getSavedExternalJobs), externalJobController.listSaved);
router.delete(
  '/saved/:externalId',
  auth(),
  requireExternalJobsAccess({ requireManage: true }),
  validate(externalJobValidation.unsaveExternalJob),
  externalJobController.unsave
);

router.post('/enrich', auth(), requireExternalJobsAccess(), validate(externalJobValidation.enrichJob), externalJobController.enrichJob);

router.post(
  '/hr-contacts',
  auth(),
  requireExternalJobsAccess({ requireManage: true }),
  validate(externalJobValidation.saveHrContact),
  externalJobController.saveHrContact
);
router.get('/hr-contacts/ids', auth(), requireExternalJobsAccess(), externalJobController.listSavedHrContactIds);
router.get(
  '/hr-contacts',
  auth(),
  requireExternalJobsAccess(),
  validate(externalJobValidation.getSavedHrContacts),
  externalJobController.listSavedHrContacts
);
router.delete(
  '/hr-contacts/:apolloId',
  auth(),
  requireExternalJobsAccess({ requireManage: true }),
  validate(externalJobValidation.deleteHrContact),
  externalJobController.deleteHrContact
);

// Apollo webhook — verified by secret token in URL path (set APOLLO_WEBHOOK_SECRET in .env)
router.post('/webhook/apollo/:secret', (req, res, next) => {
  const expected = config.apollo.webhookSecret;
  if (expected && req.params.secret !== expected) {
    return res.status(403).send({ message: 'Forbidden' });
  }
  next();
}, externalJobController.apolloWebhook);

export default router;
