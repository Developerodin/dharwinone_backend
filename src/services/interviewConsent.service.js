import httpStatus from 'http-status';
import Meeting from '../models/meeting.model.js';
import ApiError from '../utils/ApiError.js';
import { TokenVerifier } from 'livekit-server-sdk';
import { INTERVIEW_NOTICE_VERSION, getInterviewNotice } from '../constants/interviewNotices.js';
import config from '../config/config.js';
import logger from '../config/logger.js';

const consentEntryKey = (identity, noticeVersion) => `${identity}::${noticeVersion}`;

export const latestConsentForIdentity = (meeting, identity) => {
  const rows = meeting?.participantConsents || [];
  const forIdentity = rows.filter((c) => c.identity === identity && !c.withdrawnAt);
  if (!forIdentity.length) return null;
  return forIdentity.sort((a, b) => new Date(b.acceptedAt) - new Date(a.acceptedAt))[0];
};

export const hasRecordingConsent = (meeting, identity) => {
  const row = latestConsentForIdentity(meeting, identity);
  return !!row?.recording;
};

const rosterEntryForIdentity = (meeting, identity) =>
  (meeting?.participantRoster || []).find((r) => r.identity === identity) || null;

export const verifyParticipantLiveKitToken = async (token) => {
  const apiKey = config.livekit?.apiKey;
  const apiSecret = config.livekit?.apiSecret;
  if (!apiKey || !apiSecret) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'LiveKit not configured');
  }
  const verifier = new TokenVerifier(apiKey, apiSecret);
  try {
    return await verifier.verify(token);
  } catch (err) {
    logger.warn('[InterviewConsent] token verify failed', { error: err.message });
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid or expired token');
  }
};

export const recordParticipantConsent = async ({
  roomName,
  token,
  noticeVersion = INTERVIEW_NOTICE_VERSION,
  recording,
  transcription,
  aiEvaluation,
}) => {
  if (!getInterviewNotice(noticeVersion)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Unknown notice version');
  }
  const payload = await verifyParticipantLiveKitToken(token);
  const identity = String(payload.sub || '').trim();
  const video = payload.video || {};
  const room = video.room || video.roomName || '';
  if (!identity || String(room) !== String(roomName)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Token does not match this room');
  }

  const meeting = await Meeting.findOne({ meetingId: roomName });
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const roster = rosterEntryForIdentity(meeting, identity);
  if (!roster) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Participant not on roster');
  }

  const existing = (meeting.participantConsents || []).find(
    (c) => c.identity === identity && c.noticeVersion === noticeVersion && !c.withdrawnAt
  );
  if (
    existing &&
    existing.recording === !!recording &&
    existing.transcription === !!transcription &&
    existing.aiEvaluation === !!aiEvaluation
  ) {
    return { meetingId: meeting.meetingId, identity, noticeVersion, consent: existing, replay: true };
  }

  const now = new Date();
  if (existing) {
    existing.withdrawnAt = now;
  }

  const entry = {
    identity,
    role: roster.role || 'guest',
    noticeVersion,
    recording: !!recording,
    transcription: !!transcription,
    aiEvaluation: !!aiEvaluation,
    acceptedAt: now,
    withdrawnAt: null,
  };
  meeting.participantConsents = meeting.participantConsents || [];
  meeting.participantConsents.push(entry);
  await meeting.save();

  return { meetingId: meeting.meetingId, identity, noticeVersion, consent: entry, replay: false };
};

export const assertRecordingConsentForRoom = async (roomName) => {
  if (!config.livekit?.recordingConsentRequired) return;
  const meeting = await Meeting.findOne({ meetingId: roomName });
  if (!meeting || meeting.meetingKind === 'internal') return;

  let participants = [];
  try {
    const { listRoomParticipants } = await import('./livekit.service.js');
    participants = await listRoomParticipants(roomName);
  } catch (err) {
    logger.warn('[InterviewConsent] listParticipants failed', { roomName, error: err.message });
    return;
  }

  const roster = meeting.participantRoster || [];
  const candidateIdentities = new Set(
    roster.filter((r) => r.role === 'candidate').map((r) => r.identity)
  );
  if (!candidateIdentities.size) return;

  const connectedCandidates = participants.filter((p) => candidateIdentities.has(p.identity));
  if (!connectedCandidates.length) return;

  for (const p of connectedCandidates) {
    if (!hasRecordingConsent(meeting, p.identity)) {
      throw new ApiError(httpStatus.CONFLICT, 'Recording consent required', true, '', {
        errorCode: 'consent_required',
      });
    }
  }
};

export { consentEntryKey, INTERVIEW_NOTICE_VERSION };
