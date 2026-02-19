import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as livekitService from '../services/livekit.service.js';
import ApiError from '../utils/ApiError.js';

/**
 * Generate LiveKit access token
 * POST /v1/livekit/token
 */
const getToken = catchAsync(async (req, res) => {
  const { roomName, participantName, participantEmail } = req.body;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Use authenticated user info as defaults
  const participantIdentity = req.user?.id || req.user?._id?.toString() || `user-${Date.now()}`;
  const name = participantName || req.user?.name || req.user?.email || 'Anonymous';
  const email = participantEmail || req.user?.email || null;

  const { token, isHost } = await livekitService.generateAccessToken({
    roomName,
    participantName: name,
    participantIdentity,
    participantEmail: email,
  });

  res.status(httpStatus.OK).json({
    token,
    roomName,
    participantName: name,
    participantIdentity,
    isHost,
  });
});

/**
 * Start recording for a room
 * POST /v1/livekit/recording/start
 */
const startRecording = catchAsync(async (req, res) => {
  const { roomName } = req.body;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  const result = await livekitService.startRecording(roomName);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Recording started',
  });
});

/**
 * Stop recording
 * POST /v1/livekit/recording/stop
 */
const stopRecording = catchAsync(async (req, res) => {
  const { egressId } = req.body;

  if (!egressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'egressId is required');
  }

  const result = await livekitService.stopRecording(egressId);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Recording stopped',
  });
});

/**
 * Get recording status for a room
 * GET /v1/livekit/recording/status/:roomName
 */
const getRecordingStatus = catchAsync(async (req, res) => {
  const { roomName } = req.params;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  const result = await livekitService.getRecordingStatus(roomName);

  res.status(httpStatus.OK).json(result);
});

/**
 * Generate LiveKit access token (public, no auth)
 * POST /v1/public/livekit-token
 * Body: { roomName, participantName }
 */
const getTokenPublic = catchAsync(async (req, res) => {
  const { roomName, participantName, participantEmail, participantIdentity: bodyIdentity } = req.body;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  const name = participantName?.trim() || 'Guest';
  const participantIdentity = bodyIdentity?.trim() || `guest-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const { token, isHost } = await livekitService.generateAccessToken({
    roomName,
    participantName: name,
    participantIdentity,
    participantEmail: participantEmail?.trim() || null,
  });

  res.status(httpStatus.OK).json({
    token,
    roomName,
    participantName: name,
    participantIdentity,
    isHost,
  });
});

/**
 * Get waiting participants for a room
 * GET /v1/livekit/waiting-participants/:roomName
 */
const getWaitingParticipants = catchAsync(async (req, res) => {
  const { roomName } = req.params;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  const participants = await livekitService.getWaitingParticipants(roomName);

  res.status(httpStatus.OK).json({
    success: true,
    participants,
  });
});

/**
 * Admit a waiting participant
 * POST /v1/livekit/admit-participant
 * Body: { roomName, participantIdentity, participantName?, participantEmail? }
 */
const admitParticipant = catchAsync(async (req, res) => {
  const { roomName, participantIdentity, participantName, participantEmail } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  // Generate new token with full permissions for the participant
  const result = await livekitService.admitParticipant(
    roomName, 
    participantIdentity,
    participantName,
    participantEmail
  );

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Participant admitted successfully. They will need to reconnect with the new token.',
  });
});

/**
 * Remove/deny a waiting participant
 * POST /v1/livekit/remove-participant
 * Body: { roomName, participantIdentity }
 */
const removeParticipant = catchAsync(async (req, res) => {
  const { roomName, participantIdentity } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  const result = await livekitService.removeParticipant(roomName, participantIdentity);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Participant removed successfully',
  });
});

/**
 * Get waiting participants for a room (public, no auth)
 * GET /v1/public/waiting-participants/:roomName
 * Query params: ?hostEmail=email@example.com (to verify host status)
 */
const getWaitingParticipantsPublic = catchAsync(async (req, res) => {
  const { roomName } = req.params;
  const { hostEmail } = req.query;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Note: We allow ALL participants to view waiting participants (read-only)
  // This allows everyone to hide waiting participants from their view
  // Only host verification is required for admit/remove actions, not for viewing

  const participants = await livekitService.getWaitingParticipants(roomName);

  res.status(httpStatus.OK).json({
    success: true,
    participants,
  });
});

/**
 * Admit a waiting participant (public, no auth)
 * POST /v1/public/admit-participant
 * Body: { roomName, participantIdentity, participantName?, participantEmail?, hostEmail? }
 */
const admitParticipantPublic = catchAsync(async (req, res) => {
  const { roomName, participantIdentity, participantName, participantEmail, hostEmail } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  // Verify host status if email is provided
  if (hostEmail) {
    const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
    if (!isHost) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can admit participants');
    }
  }

  const result = await livekitService.admitParticipant(
    roomName, 
    participantIdentity,
    participantName,
    participantEmail
  );

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Participant admitted successfully. They will need to reconnect with the new token.',
  });
});

/**
 * Remove/deny a waiting participant (public, no auth)
 * POST /v1/public/remove-participant
 * Body: { roomName, participantIdentity, hostEmail? }
 */
const removeParticipantPublic = catchAsync(async (req, res) => {
  const { roomName, participantIdentity, hostEmail } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  // Verify host status if email is provided
  if (hostEmail) {
    const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
    if (!isHost) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can remove participants');
    }
  }

  const result = await livekitService.removeParticipant(roomName, participantIdentity);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Participant removed successfully',
  });
});

export { 
  getToken, 
  startRecording, 
  stopRecording, 
  getRecordingStatus, 
  getTokenPublic,
  getWaitingParticipants,
  admitParticipant,
  removeParticipant,
  getWaitingParticipantsPublic,
  admitParticipantPublic,
  removeParticipantPublic,
};
