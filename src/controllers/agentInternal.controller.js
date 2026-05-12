import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import logger from '../config/logger.js';

/** POST /v1/internal/meetings/:meetingId/agent-joined */
export const agentJoined = catchAsync(async (req, res) => {
  const { meetingId } = req.params;
  const { roomSid, participantCount } = req.body || {};

  const dispatch = await AgentDispatch.findOneAndUpdate(
    { _id: req.agentDispatch.id, status: 'requested' },
    { $set: { status: 'running', joinedAt: new Date(), lastHeartbeat: new Date() } },
    { new: true }
  );
  if (!dispatch) {
    return res.status(httpStatus.CONFLICT).json({ message: 'dispatch already advanced' });
  }

  await Recording.findOneAndUpdate(
    { meetingId, aiProcessingStatus: 'dispatching' },
    { $set: { aiProcessingStatus: 'transcribing' } }
  );

  logger.info('[AgentInternal] agent-joined', { meetingId, roomSid, participantCount });
  return res.status(httpStatus.OK).json({ status: 'ok' });
});
