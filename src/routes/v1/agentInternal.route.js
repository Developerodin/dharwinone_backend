import express from 'express';
import { verifyAgentHmac } from '../../middlewares/agentAuth.js';
import * as agentInternal from '../../controllers/agentInternal.controller.js';

const router = express.Router();

router.post('/meetings/:meetingId/agent-joined', verifyAgentHmac, agentInternal.agentJoined);
router.post('/meetings/:meetingId/transcript-segments', verifyAgentHmac, agentInternal.transcriptSegments);

// Remaining endpoints registered in later tasks:
//   - partial-transcripts  (Task 20)
//   - heartbeat            (Task 20)
//   - finalize             (Task 29)

export default router;
