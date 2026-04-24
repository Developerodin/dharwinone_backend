import {
  AccessToken,
  EgressClient,
  RoomServiceClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  EgressStatus,
} from 'livekit-server-sdk';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { getMeetingByMeetingId } from './meetingLookup.service.js';
import Recording from '../models/recording.model.js';
import Meeting from '../models/meeting.model.js';
import InternalMeeting from '../models/internalMeeting.model.js';

// Initialize LiveKit clients
// Convert ws:// to http:// for SDK clients (they use HTTP, not WebSocket)
const livekitUrl = config.livekit?.url?.replace(/^ws/, 'http') || 'http://localhost:7880';
const apiKey = config.livekit?.apiKey;
const apiSecret = config.livekit?.apiSecret;

// Log config on load (never log apiSecret)
logger.info('[LiveKit] Config loaded', {
  url: config.livekit?.url,
  livekitUrl,
  hasApiKey: !!apiKey,
  apiKey: apiKey || '(empty)',
  hasApiSecret: !!apiSecret,
  minioEndpoint: config.livekit?.minio?.endpoint,
  minioBucket: config.livekit?.minio?.bucket,
});

if (!apiKey || !apiSecret) {
  logger.warn('[LiveKit] Credentials not configured - token/recording endpoints will fail');
}

let egressClient = null;
let roomService = null;

// Track admitted participants: roomName -> Set of participant identities
const admittedParticipants = new Map();

if (apiKey && apiSecret) {
  try {
    egressClient = new EgressClient(livekitUrl, apiKey, apiSecret);
    roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    logger.info('[LiveKit] Clients initialized', { url: livekitUrl, egress: !!egressClient, roomService: !!roomService });
  } catch (error) {
    logger.warn('[LiveKit] Failed to initialize clients', { error: error.message, url: livekitUrl });
  }
}

/**
 * Check if a participant is a host for a meeting
 * @param {string} roomName - Room name (same as meetingId)
 * @param {string} participantEmail - Participant email
 * @returns {Promise<boolean>} True if participant is a host
 */
const isParticipantHost = async (roomName, participantEmail) => {
  try {
    const meeting = await getMeetingByMeetingId(String(roomName || '').trim());
    if (!meeting) {
      return false;
    }

    const emailLower = participantEmail?.toLowerCase().trim();
    if (!emailLower) return false;

    if (meeting.hosts?.some((host) => host.email?.toLowerCase().trim() === emailLower)) {
      return true;
    }

    const creator = meeting.createdBy;
    if (creator && typeof creator === 'object' && creator.email) {
      if (String(creator.email).toLowerCase().trim() === emailLower) {
        return true;
      }
    }

    if (meeting.recruiter?.email && String(meeting.recruiter.email).toLowerCase().trim() === emailLower) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking host status:', error);
    return false;
  }
};

/**
 * Generate LiveKit access token for a participant
 * @param {Object} options - Token generation options
 * @param {string} options.roomName - Room name
 * @param {string} options.participantName - Display name
 * @param {string} options.participantIdentity - Unique identity (usually user ID)
 * @param {string} options.participantEmail - Participant email (optional, for host check)
 * @param {boolean} options.forceFullPermissions - Force full permissions (for admitted participants)
 * @returns {Promise<{token: string, isHost: boolean, canPublish: boolean, meetingEndAt: string|null}>} JWT token and participant grants
 */
const generateAccessToken = async ({ roomName, participantName, participantIdentity, participantEmail, forceFullPermissions = false }) => {
  logger.info('[LiveKit] generateAccessToken', { roomName, participantName, participantIdentity: participantIdentity || '(none)' });

  if (!apiKey || !apiSecret) {
    logger.error('[LiveKit] generateAccessToken failed: credentials not configured');
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'LiveKit credentials not configured');
  }

  if (!roomName || !participantName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantName are required');
  }

  // Reject token for cancelled meetings
  const meeting = await getMeetingByMeetingId(roomName);
  if (meeting && meeting.status === 'cancelled') {
    throw new ApiError(httpStatus.GONE, 'This meeting has been cancelled');
  }

  // True host identity is based on meeting host/recruiter/creator email only.
  const hostByEmail = participantEmail ? await isParticipantHost(roomName, participantEmail) : false;

  // If true, guest is before scheduled start and room not yet open — still issue a token with canPublish: false
  // so the public /join/room page can connect and show the lobby (instead of HTTP 403 on getPublicLiveKitToken).
  let preStartBlockPublish = false;

  // Enforce schedule window + capacity + guest policy for scheduled meetings.
  if (meeting) {
    const nowMs = Date.now();
    const startMs = meeting.scheduledAt ? new Date(meeting.scheduledAt).getTime() : null;
    const durationMinutes = Number(meeting.durationMinutes) > 0 ? Number(meeting.durationMinutes) : 60;
    const endMs = startMs ? startMs + durationMinutes * 60 * 1000 : null;
    let participantsInRoom = null;

    if (roomService) {
      try {
        participantsInRoom = await roomService.listParticipants(roomName);
      } catch {
        participantsInRoom = null;
      }
    }

    if (startMs && nowMs < startMs && !hostByEmail) {
      // Allow invitees to join early with full (non-waiting) access once the host has opened the room.
      // Before that, do not 403: mint subscribe-only; client shows waiting/lobby until start or host joins.
      const roomAlreadyOpened = Array.isArray(participantsInRoom) && participantsInRoom.length > 0;
      if (!roomAlreadyOpened) {
        preStartBlockPublish = true;
      }
    }
    if (endMs && nowMs > endMs) {
      throw new ApiError(httpStatus.GONE, 'Meeting has ended');
    }

    if (!meeting.allowGuestJoin && !hostByEmail) {
      const emailLower = String(participantEmail || '').toLowerCase().trim();
      const allowedEmails = new Set();
      (meeting.hosts || []).forEach((h) => {
        if (h?.email) allowedEmails.add(String(h.email).toLowerCase().trim());
      });
      (meeting.emailInvites || []).forEach((e) => {
        if (e) allowedEmails.add(String(e).toLowerCase().trim());
      });
      if (meeting.candidate?.email) allowedEmails.add(String(meeting.candidate.email).toLowerCase().trim());
      if (meeting.recruiter?.email) allowedEmails.add(String(meeting.recruiter.email).toLowerCase().trim());
      if (!emailLower || !allowedEmails.has(emailLower)) {
        throw new ApiError(httpStatus.FORBIDDEN, 'Guest join is disabled for this meeting');
      }
    }

    if (!hostByEmail && roomService && Number(meeting.maxParticipants) > 0) {
      try {
        const currentParticipants = Array.isArray(participantsInRoom)
          ? participantsInRoom
          : await roomService.listParticipants(roomName);
        const alreadyJoined = currentParticipants.some((p) => p.identity === (participantIdentity || participantName));
        if (!alreadyJoined && currentParticipants.length >= Number(meeting.maxParticipants)) {
          throw new ApiError(httpStatus.CONFLICT, 'Meeting is full (max participants reached)');
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
      }
    }
  }

  // Check if participant has been admitted from waiting room or forcing full permissions.
  const roomAdmitted = admittedParticipants.get(roomName);
  const dbAdmitted =
    participantIdentity &&
    Array.isArray(meeting?.admittedIdentities) &&
    meeting.admittedIdentities.includes(participantIdentity);
  const isAdmitted = roomAdmitted?.has(participantIdentity) || dbAdmitted || false;
  const approvalRequired = Boolean(meeting?.requireApproval);
  const canPublish =
    (forceFullPermissions || hostByEmail || isAdmitted || (meeting ? !approvalRequired : false)) &&
    !preStartBlockPublish;
  const isHost = hostByEmail;

  logger.info('[LiveKit] Token grants', { roomName, isHost, canPublish, isAdmitted, forceFullPermissions });

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity || participantName,
    name: participantName,
    ttl: '6h', // Explicit TTL to avoid premature expiry and reconnects
  });

  // Grant permissions based on host/admission/approval rules.
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish, // Hosts, admitted users, or meetings with requireApproval=false
    canSubscribe: true, // All participants can subscribe (see/hear)
    canPublishData: canPublish,
    canUpdateOwnMetadata: true,
  });

  const jwt = await token.toJwt();

  /** Calendar end time for interview UI (scheduled start + duration). */
  let meetingEndAt = null;
  if (meeting?.scheduledAt) {
    const startMs = new Date(meeting.scheduledAt).getTime();
    if (!Number.isNaN(startMs)) {
      const durMin = Number(meeting.durationMinutes) > 0 ? Number(meeting.durationMinutes) : 60;
      meetingEndAt = new Date(startMs + durMin * 60 * 1000).toISOString();
    }
  }

  logger.info('[LiveKit] Token generated successfully', { roomName, isHost, meetingEndAt });
  return { token: jwt, isHost, canPublish, meetingEndAt };
};

/**
 * LiveKit token for platform support camera sessions (no Meeting document).
 * Viewer = superadmin (subscribe to AV only; can still send/receive data for chat).
 * Publisher = invited user (camera/mic + chat).
 * @param {Object} opts
 * @param {string} opts.roomName
 * @param {string} opts.participantName
 * @param {string} opts.participantIdentity
 * @param {boolean} opts.asPublisher
 * @returns {Promise<string>} JWT
 */
const generateSupportCameraToken = async ({ roomName, participantName, participantIdentity, asPublisher }) => {
  if (!apiKey || !apiSecret) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'LiveKit credentials not configured');
  }
  if (!roomName || !participantName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'roomName and participantName are required');
  }
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity || participantName,
    name: participantName,
    ttl: '1h',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    // Guest publishes camera/mic; viewer (superadmin) is subscribe-only for media.
    canPublish: !!asPublisher,
    canSubscribe: true,
    // In-room chat uses data packets — both sides need this so support can write and the guest can read.
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  const jwt = await token.toJwt();
  logger.info('[LiveKit] support camera token', { roomName, asPublisher });
  return jwt;
};

/**
 * Start room composite recording (egress)
 * @param {string} roomName - Room name to record
 * @returns {Promise<Object>} Egress info with egressId
 */
const startRecording = async (roomName) => {
  logger.info('[LiveKit] startRecording', { roomName });

  if (!egressClient) {
    logger.warn('[LiveKit] startRecording failed: egressClient not available');
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Recording service not available. Please configure LiveKit Egress.'
    );
  }

  if (!roomService) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Room service not available');
  }

  // Verify room exists and has participants
  try {
    const rooms = await roomService.listRooms([roomName]);
    if (rooms.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Room not found');
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to verify room: ${error.message}`);
  }

  // Determine if using local MinIO or production S3
  // LiveKit Cloud: always use AWS S3 (Egress runs on LiveKit's side)
  // Local Docker: use MinIO in dev, AWS S3 in production
  const isLiveKitCloud = (config.livekit?.url || '').includes('livekit.cloud');
  const isLocalDev =
    !isLiveKitCloud &&
    (config.env !== 'production' || !config.aws?.accessKeyId || !config.aws?.secretAccessKey);

  const s3Config = isLocalDev
    ? {
        // Local MinIO configuration
        accessKey: config.livekit?.minio?.accessKey || 'minioadmin',
        secret: config.livekit?.minio?.secretKey || 'minioadmin123',
        region: 'us-east-1',
        bucket: config.livekit?.minio?.bucket || 'recordings',
        endpoint: config.livekit?.minio?.endpoint || 'http://minio:9000', // Docker service name
        forcePathStyle: true, // Required for MinIO
      }
    : {
        // Production S3 configuration
        accessKey: config.aws.accessKeyId,
        secret: config.aws.secretAccessKey,
        region: config.aws.region || 'us-east-1',
        bucket: config.livekit?.s3Bucket || config.aws.bucketName || 'recordings',
      };

  // Use prefix so recordings live under recordings/ in the bucket (same key used for playback)
  const filepath = `recordings/${roomName}-${Date.now()}.mp4`;
  logger.info('[LiveKit] Starting egress', { roomName, filepath, endpoint: s3Config.endpoint || '(AWS)' });
  const fileOutput = new EncodedFileOutput({
    filepath,
    output: {
      case: 's3',
      value: new S3Upload(s3Config),
    },
    fileType: EncodedFileType.MP4,
  });

  try {
    const egressInfo = await egressClient.startRoomCompositeEgress(roomName, fileOutput, {
      layout: 'grid',
      audioOnly: false,
      videoOnly: false,
    });

    await Recording.create({
      meetingId: roomName,
      egressId: egressInfo.egressId,
      filePath: filepath,
      status: 'recording',
      startedAt: new Date(),
    });

    logger.info('[LiveKit] Recording started', { roomName, egressId: egressInfo.egressId });
    return {
      egressId: egressInfo.egressId,
      roomName,
      status: egressInfo.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[LiveKit] startRecording failed', { roomName, error: errorMessage });

    // Provide helpful error messages
    if (errorMessage.includes('no response from servers') || errorMessage.includes('connection refused')) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'LiveKit Egress service is not running. Please start the Egress service using docker-compose up -d'
      );
    } else if (errorMessage.includes('EGRESS_NOT_CONNECTED')) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Egress service is not connected to LiveKit server. Please check Egress configuration.'
      );
    } else if (errorMessage.includes('ws_url')) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'Egress service configuration error: ws_url is missing or invalid. Check Egress config file.'
      );
    }

    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to start recording: ${errorMessage}`
    );
  }
};

/**
 * Stop recording (egress)
 * @param {string} egressId - Egress ID to stop
 * @returns {Promise<Object>} Updated egress info
 */
const stopRecording = async (egressId) => {
  logger.info('[LiveKit] stopRecording', { egressId });

  if (!egressClient) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Recording service not available');
  }

  if (!egressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'egressId is required');
  }

  try {
    const egressInfo = await egressClient.stopEgress(egressId);
    logger.info('[LiveKit] Recording stopped', { egressId, status: egressInfo.status });
    await Recording.findOneAndUpdate(
      { egressId },
      { status: 'completed', completedAt: new Date() },
      { new: true }
    );
    return {
      egressId,
      status: egressInfo.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[LiveKit] stopRecording failed', { egressId, error: errorMessage });
    if (errorMessage.includes('no response from servers') || errorMessage.includes('connection refused')) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'LiveKit Egress service is not running. Please start the Egress service.'
      );
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to stop recording: ${errorMessage}`);
  }
};

/**
 * LiveKit EgressInfo.startedAt is often nanoseconds as bigint; JSON would stringify poorly and
 * clients parsing with `new Date(string)` break. Normalize to ISO-8601 (ms).
 * @param {unknown} v
 * @returns {string|null}
 */
const egressStartedAtToIso = (v) => {
  if (v == null) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : v.toISOString();
  }
  if (typeof v === 'bigint') {
    const ms = Number(v / 1000000n);
    return new Date(ms).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e15 ? Math.floor(v / 1e6) : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^\d+$/.test(trimmed)) {
      if (trimmed.length > 15) {
        try {
          const ms = Number(BigInt(trimmed) / 1000000n);
          return new Date(ms).toISOString();
        } catch {
          return null;
        }
      }
      const ms = Number(trimmed);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
};

/**
 * Get recording status for a room
 * @param {string} roomName - Room name
 * @returns {Promise<Object>} Recording status and list
 */
const getRecordingStatus = async (roomName) => {
  logger.info('[LiveKit] getRecordingStatus', { roomName });

  if (!egressClient) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Recording service not available');
  }

  try {
    const egressList = await egressClient.listEgress({
      roomName: roomName,
    });

    const activeRecordings = egressList.filter(
      (egress) => egress.status === EgressStatus.EGRESS_ACTIVE
    );

    return {
      isRecording: activeRecordings.length > 0,
      recordings: activeRecordings.map((egress) => ({
        egressId: egress.egressId,
        roomName: egress.roomName,
        status: egress.status,
        startedAt: egressStartedAtToIso(egress.startedAt),
      })),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[LiveKit] getRecordingStatus failed', { roomName, error: errorMessage });
    if (errorMessage.includes('no response from servers') || errorMessage.includes('connection refused')) {
      throw new ApiError(
        httpStatus.SERVICE_UNAVAILABLE,
        'LiveKit Egress service is not running. Please start the Egress service.'
      );
    }
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to get recording status: ${errorMessage}`
    );
  }
};

/**
 * Room composite egress joins internal LiveKit participants (subscribe-only) so the recorder
 * can pull tracks. Their identity is `EG_<egressId>` — not a human in the waiting room.
 * @param {string} [identity]
 * @returns {boolean}
 */
const isLiveKitEgressRecorderIdentity = (identity) => {
  if (!identity || typeof identity !== 'string') return false;
  return identity.startsWith('EG_');
};

/**
 * Get waiting participants (participants who can subscribe but not publish)
 * Uses listParticipants() which returns ParticipantInfo with permission.canPublish
 * @param {string} roomName - Room name
 * @returns {Promise<Array>} List of waiting participants
 */
const getWaitingParticipants = async (roomName) => {
  logger.info('[LiveKit] getWaitingParticipants', { roomName });

  if (!roomService) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Room service not available');
  }

  try {
    const participants = await roomService.listParticipants(roomName);
    if (!participants || participants.length === 0) {
      return [];
    }

    const meeting = await getMeetingByMeetingId(roomName);
    const dbAdmitted = new Set(
      Array.isArray(meeting?.admittedIdentities) ? meeting.admittedIdentities.filter(Boolean) : []
    );
    const memAdmitted = admittedParticipants.get(roomName) || new Set();

    // Filter participants who cannot publish (waiting room)
    // Exclude identities already admitted (DB/memory): LiveKit still shows canPublish=false until they reconnect
    const waitingParticipants = participants
      .filter((p) => {
        if (isLiveKitEgressRecorderIdentity(p.identity)) {
          return false;
        }
        if (dbAdmitted.has(p.identity) || memAdmitted.has(p.identity)) {
          return false;
        }
        const permission = p.permission;
        if (!permission) {
          return true; // No permission = treat as waiting
        }
        const canPublish = permission.canPublish === true;
        return !canPublish;
      })
      .map(p => {
        let joinedAt = new Date().toISOString();
        if (p.joinedAt != null) {
          if (typeof p.joinedAt === 'number') {
            joinedAt = p.joinedAt < 1e12 ? new Date(p.joinedAt).toISOString() : new Date(p.joinedAt / 1000).toISOString();
          } else {
            joinedAt = String(p.joinedAt);
          }
        }
        return {
          identity: p.identity,
          name: p.name || p.identity,
          joinedAt,
        };
      });

    logger.info('[LiveKit] getWaitingParticipants result', { roomName, total: participants.length, waiting: waitingParticipants.length });
    return waitingParticipants;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const roomMissing =
      errorMessage.includes('room not found') ||
      errorMessage.includes('not found') ||
      errorMessage.toLowerCase().includes('does not exist');
    if (roomMissing) {
      logger.debug('[LiveKit] getWaitingParticipants room not found', { roomName });
      return [];
    }
    logger.warn('[LiveKit] getWaitingParticipants', { roomName, error: errorMessage });
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to get waiting participants: ${errorMessage}`
    );
  }
};

/**
 * Admit a waiting participant (generate new token with full permissions)
 * Note: LiveKit doesn't allow changing permissions after join, so we generate a new token
 * The participant will need to reconnect with this new token
 * @param {string} roomName - Room name
 * @param {string} participantIdentity - Participant identity
 * @param {string} participantName - Participant name (optional, will try to get from room)
 * @param {string} participantEmail - Participant email (optional, for host check)
 * @returns {Promise<Object>} New token and participant info
 */
const admitParticipant = async (roomName, participantIdentity, participantName = null, participantEmail = null) => {
  logger.info('[LiveKit] admitParticipant', { roomName, participantIdentity });

  if (!roomService) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Room service not available');
  }

  try {
    // Get participant details from LiveKit
    let participant;
    try {
      participant = await roomService.getParticipant(roomName, participantIdentity);
    } catch (err) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Participant not found in room');
    }

    const name = participantName || participant.name || participantIdentity;
    const email = participantEmail || (participant.metadata && typeof participant.metadata === 'string' ? null : participant.metadata?.email) || null;

    // Mark participant as admitted
    if (!admittedParticipants.has(roomName)) {
      admittedParticipants.set(roomName, new Set());
    }
    admittedParticipants.get(roomName).add(participantIdentity);

    const meetingIdKey = String(roomName).trim();
    await Promise.all([
      Meeting.updateOne({ meetingId: meetingIdKey }, { $addToSet: { admittedIdentities: participantIdentity } }),
      InternalMeeting.updateOne({ meetingId: meetingIdKey }, { $addToSet: { admittedIdentities: participantIdentity } }),
    ]).catch((err) =>
      logger.warn('[LiveKit] Persist admitted identity failed', { roomName: meetingIdKey, participantIdentity, err: err?.message })
    );

    // Generate new token with full permissions (force full permissions for admitted participants)
    const { token } = await generateAccessToken({
      roomName,
      participantName: name,
      participantIdentity,
      participantEmail: email,
      forceFullPermissions: true, // Admitted participants get full permissions
    });

    // Note: We can't directly update permissions in LiveKit
    // The participant needs to disconnect and reconnect with the new token
    // This will be handled by the frontend

    logger.info('[LiveKit] Participant admitted', { roomName, participantIdentity });
    return {
      identity: participantIdentity,
      name,
      token,
      admitted: true,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[LiveKit] admitParticipant failed', { roomName, participantIdentity, error: errorMessage });
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to admit participant: ${errorMessage}`
    );
  }
};

/**
 * Remove/deny a waiting participant
 * @param {string} roomName - Room name
 * @param {string} participantIdentity - Participant identity
 * @returns {Promise<Object>} Removal result
 */
const removeParticipant = async (roomName, participantIdentity) => {
  logger.info('[LiveKit] removeParticipant', { roomName, participantIdentity });

  if (!roomService) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Room service not available');
  }

  try {
    await roomService.removeParticipant(roomName, participantIdentity);
    logger.info('[LiveKit] Participant removed', { roomName, participantIdentity });

    // Remove from admitted list if present
    const roomAdmitted = admittedParticipants.get(roomName);
    if (roomAdmitted) {
      roomAdmitted.delete(participantIdentity);
    }

    const rid = String(roomName).trim();
    await Promise.all([
      Meeting.updateOne({ meetingId: rid }, { $pull: { admittedIdentities: participantIdentity } }),
      InternalMeeting.updateOne({ meetingId: rid }, { $pull: { admittedIdentities: participantIdentity } }),
    ]).catch((err) =>
      logger.warn('[LiveKit] Remove admitted identity from DB failed', { roomName, participantIdentity, err: err?.message })
    );

    return {
      identity: participantIdentity,
      removed: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[LiveKit] removeParticipant failed', { roomName, participantIdentity, error: errorMessage });
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      `Failed to remove participant: ${errorMessage}`
    );
  }
};

/**
 * Check if a participant has been admitted
 * @param {string} roomName - Room name
 * @param {string} participantIdentity - Participant identity
 * @returns {boolean} True if participant has been admitted
 */
const isParticipantAdmitted = (roomName, participantIdentity) => {
  const roomAdmitted = admittedParticipants.get(roomName);
  return roomAdmitted?.has(participantIdentity) || false;
};

/**
 * Get number of participants currently in a LiveKit room
 * @param {string} roomName - Room name
 * @returns {Promise<number>} Participant count, 0 if room empty or error
 */
const getRoomParticipantCount = async (roomName) => {
  if (!roomService) return 0;
  try {
    const participants = await roomService.listParticipants(roomName);
    return participants?.length ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Disconnect all participants in a room (e.g. when ending a 1-on-1 chat call)
 * @param {string} roomName - Room name
 */
const disconnectAllParticipants = async (roomName) => {
  if (!roomService) return;
  try {
    const participants = await roomService.listParticipants(roomName);
    if (!participants || participants.length === 0) return;
    for (const p of participants) {
      try {
        await roomService.removeParticipant(roomName, p.identity);
        logger.info('[LiveKit] Disconnected participant (call ended)', { roomName, identity: p.identity });
      } catch (e) {
        logger.warn(`[LiveKit] Failed to disconnect ${p.identity}: ${e?.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[LiveKit] disconnectAllParticipants failed for ${roomName}: ${err?.message}`);
  }
};

/**
 * End LiveKit room for an interview (disconnect everyone, then delete room).
 * Safe to call if the room no longer exists.
 * @param {string} roomName
 */
const deleteInterviewRoom = async (roomName) => {
  const rid = String(roomName || '').trim();
  if (!rid || !roomService) {
    logger.warn('[LiveKit] deleteInterviewRoom skipped', { roomName: rid, hasRoomService: !!roomService });
    return { deleted: false };
  }
  await disconnectAllParticipants(rid);
  try {
    await roomService.deleteRoom(rid);
    logger.info('[LiveKit] deleteRoom completed', { roomName: rid });
    return { deleted: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|no room/i.test(msg)) {
      logger.info('[LiveKit] deleteRoom no-op (already gone)', { roomName: rid });
      return { deleted: false };
    }
    logger.warn('[LiveKit] deleteRoom failed', { roomName: rid, error: msg });
    return { deleted: false };
  }
};

export { 
  generateAccessToken,
  generateSupportCameraToken,
  startRecording, 
  stopRecording, 
  getRecordingStatus,
  getWaitingParticipants,
  admitParticipant,
  removeParticipant,
  getRoomParticipantCount,
  disconnectAllParticipants,
  deleteInterviewRoom,
  isParticipantHost,
  isParticipantAdmitted,
};
