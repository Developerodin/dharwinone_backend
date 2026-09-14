import express from 'express';
import { verifyAgentHmac, requireProtocolV2 } from '../../middlewares/agentAuth.js';
import * as agentInternal from '../../controllers/agentInternal.controller.js';

const router = express.Router();

router.post(
  '/meetings/:meetingId/runs',
  verifyAgentHmac,
  requireProtocolV2,
  agentInternal.runsValidation,
  agentInternal.runs
);
router.post(
  '/meetings/:meetingId/transcript-batches',
  verifyAgentHmac,
  requireProtocolV2,
  agentInternal.transcriptBatchesValidation,
  agentInternal.transcriptBatches
);
router.post('/meetings/:meetingId/agent-joined', verifyAgentHmac, agentInternal.agentJoined);
router.post('/meetings/:meetingId/transcript-segments', verifyAgentHmac, agentInternal.transcriptSegments);
router.post('/meetings/:meetingId/partial-transcripts', verifyAgentHmac, agentInternal.partialTranscripts);
router.post('/meetings/:meetingId/heartbeat', verifyAgentHmac, agentInternal.heartbeat);
router.post('/meetings/:meetingId/finalize', verifyAgentHmac, agentInternal.finalize);

export default router;
