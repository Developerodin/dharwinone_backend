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
import { getMeetingByMeetingId } from './meeting.service.js';
import Recording from '../models/recording.model.js';

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
    const meeting = await getMeetingByMeetingId(roomName);
    if (!meeting) {
      return false;
    }
    
    // Check if participant email is in hosts array
    const emailLower = participantEmail?.toLowerCase().trim();
    return meeting.hosts?.some(host => host.email?.toLowerCase().trim() === emailLower) || false;
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
 * @returns {Promise<{token: string, isHost: boolean}>} JWT token and host status
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

  // Check if participant is a host, has been admitted, or forcing full permissions
  const roomAdmitted = admittedParticipants.get(roomName);
  const isAdmitted = roomAdmitted?.has(participantIdentity) || false;
  const isHost = forceFullPermissions || isAdmitted || (participantEmail ? await isParticipantHost(roomName, participantEmail) : false);

  logger.info('[LiveKit] Token grants', { roomName, isHost, isAdmitted, forceFullPermissions });

  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantIdentity || participantName,
    name: participantName,
    ttl: '6h', // Explicit TTL to avoid premature expiry and reconnects
  });

  // Grant permissions based on host status
  // Hosts get full permissions, non-hosts can only subscribe (waiting room)
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: isHost, // Only hosts can publish initially
    canSubscribe: true, // All participants can subscribe (see/hear)
    canPublishData: isHost, // Only hosts can publish data initially
    canUpdateOwnMetadata: true,
  });

  const jwt = await token.toJwt();
  logger.info('[LiveKit] Token generated successfully', { roomName, isHost });
  return { token: jwt, isHost };
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

    // Helper function to serialize BigInt and Date for JSON
    const serializeBigInt = (value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (Array.isArray(value)) {
        return value.map(serializeBigInt);
      }
      if (value && typeof value === 'object') {
        const serialized = {};
        for (const [key, val] of Object.entries(value)) {
          serialized[key] = serializeBigInt(val);
        }
        return serialized;
      }
      return value;
    };

    return {
      isRecording: activeRecordings.length > 0,
      recordings: activeRecordings.map((egress) =>
        serializeBigInt({
          egressId: egress.egressId,
          roomName: egress.roomName,
          status: egress.status,
          startedAt: egress.startedAt,
        })
      ),
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

    // Filter participants who cannot publish (waiting room)
    // ParticipantInfo has permission.canPublish (from LiveKit protocol)
    const waitingParticipants = participants
      .filter(p => {
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

export { 
  generateAccessToken, 
  startRecording, 
  stopRecording, 
  getRecordingStatus,
  getWaitingParticipants,
  admitParticipant,
  removeParticipant,
  isParticipantHost,
  isParticipantAdmitted,
};
