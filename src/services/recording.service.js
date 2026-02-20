import Recording from '../models/recording.model.js';
import Meeting from '../models/meeting.model.js';
import { generatePresignedRecordingPlaybackUrl } from '../config/s3.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

const PLAYBACK_URL_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Resolve meeting identifier to meetingId (roomName) for Recording queries.
 * @param {string} id - Meeting _id (MongoDB ObjectId) or meetingId string
 * @returns {Promise<string>} meetingId (roomName)
 */
const resolveMeetingId = async (id) => {
  if (!id) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Meeting id is required');
  }
  // If it looks like MongoDB ObjectId (24 hex chars), find meeting
  if (/^[a-fA-F0-9]{24}$/.test(id)) {
    const meeting = await Meeting.findById(id);
    if (!meeting) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
    }
    return meeting.meetingId;
  }
  // Otherwise treat as meetingId
  const meeting = await Meeting.findOne({ meetingId: id });
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  return id;
};

/**
 * List recordings for a meeting with signed playback URLs (completed only).
 * @param {string} meetingIdOrMongoId - Meeting id (MongoDB _id or meetingId string)
 * @returns {Promise<Array<{ id, meetingId, egressId, filePath, status, startedAt, completedAt, playbackUrl }>>}
 */
const listByMeetingId = async (meetingIdOrMongoId) => {
  const meetingId = await resolveMeetingId(meetingIdOrMongoId);
  const recordings = await Recording.find({ meetingId })
    .sort({ startedAt: -1 })
    .lean();

  const result = [];
  for (const rec of recordings) {
    const item = {
      id: rec._id?.toString(),
      meetingId: rec.meetingId,
      egressId: rec.egressId,
      filePath: rec.filePath,
      status: rec.status,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt,
    };
    if (rec.status === 'completed' && rec.filePath) {
      try {
        item.playbackUrl = await generatePresignedRecordingPlaybackUrl(
          rec.filePath,
          PLAYBACK_URL_EXPIRY_SECONDS
        );
      } catch (err) {
        item.playbackUrl = null;
        item.playbackError = err.message || 'Failed to generate playback URL';
      }
    }
    result.push(item);
  }
  return result;
};

export default {
  listByMeetingId,
  resolveMeetingId,
};
