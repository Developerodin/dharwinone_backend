import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as livekitService from '../services/livekit.service.js';
import * as chatService from '../services/chat.service.js';
import * as chatCallService from '../services/chatCall.service.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

const parseChatRoomConversationId = (roomName) => {
  if (!roomName || !roomName.startsWith('chat-')) return null;
  const parts = roomName.split('-');
  if (parts.length >= 2) return parts[1];
  return null;
};

/**
 * Generate LiveKit access token
 * POST /v1/livekit/token
 */
const getToken = catchAsync(async (req, res) => {
  const { roomName, participantName, participantEmail, forChatCall } = req.body;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Use authenticated user info as defaults
  const participantIdentity = req.user?.id || req.user?._id?.toString() || `user-${Date.now()}`;
  const name = participantName || req.user?.name || req.user?.email || 'Anonymous';
  const email = participantEmail || req.user?.email || null;

  // Chat calls: P2P — no meeting logic, no waiting room, no host gating
  if (roomName.startsWith('chat-')) {
    const conversationId = parseChatRoomConversationId(roomName);
    if (!conversationId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid chat room name');
    }
    await chatService.ensureParticipant(conversationId, participantIdentity);
    const chatToken = await chatCallService.mintP2PToken(roomName, participantIdentity, name);
    return res.status(httpStatus.OK).json({
      token: chatToken,
      roomName,
      participantName: name,
      participantIdentity,
      isHost: true,    // all peers equal — prevents waiting room UI
      canPublish: true,
      meetingEndAt: null,
    });
  }

  const { token, isHost, canPublish, meetingEndAt } = await livekitService.generateAccessToken({
    roomName,
    participantName: name,
    participantIdentity,
    participantEmail: email,
    forceFullPermissions: forChatCall,
  });

  res.status(httpStatus.OK).json({
    token,
    roomName,
    participantName: name,
    participantIdentity,
    isHost,
    canPublish,
    meetingEndAt,
  });
});

/**
 * Start recording for a room (authenticated – host only)
 * POST /v1/livekit/recording/start
 */
const startRecording = catchAsync(async (req, res) => {
  const { roomName } = req.body;
  const participantEmail = req.user?.email;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  const isHost = await livekitService.isParticipantHost(roomName, participantEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the meeting host can start recording');
  }

  const result = await livekitService.startRecording(roomName);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Recording started',
  });
});

/**
 * Stop recording (authenticated – host only)
 * POST /v1/livekit/recording/stop
 */
const stopRecording = catchAsync(async (req, res) => {
  const { egressId, roomName } = req.body;
  const participantEmail = req.user?.email;

  if (!egressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'egressId is required');
  }
  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required to verify host');
  }

  const isHost = await livekitService.isParticipantHost(roomName, participantEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the meeting host can stop recording');
  }

  const result = await livekitService.stopRecording(egressId, roomName);

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

  // Chat calls require authentication – only conversation participants can join
  if (roomName.startsWith('chat-')) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Chat calls require authentication. Please sign in to join.');
  }

  const name = participantName?.trim() || 'Guest';
  const participantIdentity = bodyIdentity?.trim() || `guest-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const { token, isHost, canPublish, meetingEndAt, knocking, allowGuestJoin } = await livekitService.generateAccessToken({
    roomName,
    participantName: name,
    participantIdentity,
    participantEmail: participantEmail?.trim() || null,
    // Unauthenticated callers can never be granted host status: email is self-asserted
    // here, so host privilege only comes from the authenticated /livekit/token path.
    forcePublicGuest: true,
  });

  res.status(httpStatus.OK).json({
    token,
    roomName,
    participantName: name,
    participantIdentity,
    isHost,
    canPublish,
    meetingEndAt,
    knocking, // uninvited guest → client knocks (auto if allowGuestJoin, else "Ask for permission")
    allowGuestJoin, // true → auto-knock; false → explicit ask-for-permission button
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

  // Waiting roster contains participant names (PII) — only the meeting host may see it.
  const hostEmail = req.user?.email;
  if (!hostEmail || !(await livekitService.isParticipantHost(roomName, hostEmail))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the meeting host can view waiting participants');
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

  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Authenticated user email required to admit participants');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can admit participants');
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

  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Authenticated user email required to remove participants');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can remove participants');
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
 */
const getWaitingParticipantsPublic = catchAsync(async (req, res) => {
  const { roomName } = req.params;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Unauthenticated/guest view: return ONLY opaque identities so the client can hide
  // waiting users from its grid. Names and other PII are stripped — the full roster is
  // host-only via the authenticated /livekit/waiting-participants endpoint.
  const participants = await livekitService.getWaitingParticipants(roomName);
  const identitiesOnly = (participants || []).map((p) => ({ identity: p.identity }));

  res.status(httpStatus.OK).json({
    success: true,
    participants: identitiesOnly,
  });
});

/**
 * Admit a waiting participant (public, no auth)
 * POST /v1/public/admit-participant
 * Body: { roomName, participantIdentity, participantName?, participantEmail?, hostEmail? }
 */
const admitParticipantPublic = catchAsync(async (req, res) => {
  const { roomName, participantIdentity, participantName, participantEmail } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  // Host identity comes from the authenticated session, never a request-body email
  // (which is not a secret and was trivially spoofable). Route requires auth().
  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication required for host actions');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can admit participants');
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
  const { roomName, participantIdentity } = req.body;

  if (!roomName || !participantIdentity) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantIdentity are required');
  }

  // Host identity from the authenticated session, not a spoofable body email. Route requires auth().
  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication required for host actions');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only hosts can remove participants');
  }

  const result = await livekitService.removeParticipant(roomName, participantIdentity);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Participant removed successfully',
  });
});

/**
 * Start recording (public – host only, no auth)
 * POST /v1/public/recording/start
 * Body: { roomName, hostEmail }
 */
const startRecordingPublic = catchAsync(async (req, res) => {
  const { roomName } = req.body;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Host identity from the authenticated session, not a spoofable body email. Route requires auth().
  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication required for host actions');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the meeting host can start recording');
  }

  const result = await livekitService.startRecording(roomName);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Recording started',
  });
});

/**
 * Stop recording (public – host only, no auth)
 * POST /v1/public/recording/stop
 * Body: { egressId, roomName, hostEmail }
 */
const stopRecordingPublic = catchAsync(async (req, res) => {
  const { egressId, roomName } = req.body;

  if (!egressId || !roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'egressId and roomName are required');
  }

  // Host identity from the authenticated session, not a spoofable body email. Route requires auth().
  const hostEmail = req.user?.email;
  if (!hostEmail) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication required for host actions');
  }
  const isHost = await livekitService.isParticipantHost(roomName, hostEmail);
  if (!isHost) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the meeting host can stop recording');
  }

  const result = await livekitService.stopRecording(egressId);

  res.status(httpStatus.OK).json({
    success: true,
    ...result,
    message: 'Recording stopped',
  });
});

/**
 * Get recording status (public – no auth, anyone in room can check)
 * GET /v1/public/recording/status/:roomName
 */
const getRecordingStatusPublic = catchAsync(async (req, res) => {
  const { roomName } = req.params;

  if (!roomName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName is required');
  }

  // Guests need only the recording on/off state for the consent indicator. Egress
  // ids and timestamps are internal metadata — omit them from the unauthenticated view.
  // This is a non-critical 5s poll from every participant; if the egress service is
  // unavailable or errors, degrade to "not recording" instead of 500-spamming the room.
  let isRecording = false;
  try {
    const result = await livekitService.getRecordingStatus(roomName);
    isRecording = Boolean(result?.isRecording);
  } catch (error) {
    logger.warn('[LiveKit] public recording status unavailable; defaulting to not-recording', {
      roomName,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  res.status(httpStatus.OK).json({ isRecording });
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
  startRecordingPublic,
  stopRecordingPublic,
  getRecordingStatusPublic,
};
