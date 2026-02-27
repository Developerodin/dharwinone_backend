import express from 'express';
import * as bolnaController from '../../controllers/bolna.controller.js';
import * as livekitWebhookController from '../../controllers/livekitWebhook.controller.js';

const router = express.Router();

// Job verification webhook (recruiter calls)
router
  .route('/bolna-calls')
  .post(bolnaController.receiveWebhook);

// Candidate verification webhook (student/candidate calls)
router
  .route('/bolna-candidate-calls')
  .post(bolnaController.receiveCandidateWebhook);

/** LiveKit Egress webhook - receives egress_started, egress_updated, egress_ended */
router
  .route('/livekit-egress')
  .post(livekitWebhookController.receiveLiveKitEgressWebhook);

export default router;

