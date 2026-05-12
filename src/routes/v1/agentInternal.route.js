import express from 'express';
import { verifyAgentHmac } from '../../middlewares/agentAuth.js';
import * as agentInternal from '../../controllers/agentInternal.controller.js';

const router = express.Router();

router.post('/meetings/:meetingId/agent-joined', verifyAgentHmac, agentInternal.agentJoined);
router.post('/meetings/:meetingId/transcript-segments', verifyAgentHmac, agentInternal.transcriptSegments);
router.post('/meetings/:meetingId/partial-transcripts', verifyAgentHmac, agentInternal.partialTranscripts);
router.post('/meetings/:meetingId/heartbeat', verifyAgentHmac, agentInternal.heartbeat);

// Remaining endpoints registered in later tasks:
//   - finalize             (Task 29)

export default router;
