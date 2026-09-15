import httpStatus from 'http-status';
import TranscriptVersion from '../models/transcriptVersion.model.js';
import Summary from '../models/summary.model.js';
import ApiError from '../utils/ApiError.js';
import { readJsonFromS3 } from './aiArtifactStorage.service.js';
import { buildTranscriptOwnerKey } from './transcriptAssembly.service.js';
import { getMeetingById } from './meeting.service.js';

const MAX_CONTEXT_WINDOW = 5;

const sanitizeUtterance = (u) => ({
  utteranceId: u.utteranceId,
  displayName: u.displayName ?? null,
  speakerRole: u.speakerRole ?? 'unknown',
  roleAssurance: u.roleAssurance ?? null,
  participantIdentity: u.participantIdentity ?? null,
  text: u.text ?? '',
  recordingOffsetMs: u.recordingOffsetMs ?? null,
  startedAtEpochMs: u.startedAtEpochMs ?? null,
  endedAtEpochMs: u.endedAtEpochMs ?? null,
  confidence: u.confidence ?? null,
});

const meetingInterviewId = (meeting) => meeting.id || meeting._id?.toString?.() || String(meeting._id);

const resolveTranscriptVersion = async (ownerKey, versionParam) => {
  if (versionParam != null && versionParam !== '') {
    const v = Number(versionParam);
    if (!Number.isInteger(v) || v < 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid transcript version');
    }
    return TranscriptVersion.findOne({ ownerKey, version: v }).lean();
  }
  return TranscriptVersion.findOne({ ownerKey }).sort({ version: -1 }).lean();
};

const loadVersionPayload = async (versionDoc) => {
  if (!versionDoc?.s3Key) return null;
  try {
    return await readJsonFromS3({ key: versionDoc.s3Key });
  } catch {
    return null;
  }
};

export const getInterviewTranscript = async (meetingId, currentUser, options = {}) => {
  const meeting = await getMeetingById(meetingId, currentUser);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const interviewId = meetingInterviewId(meeting);
  const ownerKey = buildTranscriptOwnerKey({ interviewId, meetingId: meeting.meetingId });
  const versionDoc = await resolveTranscriptVersion(ownerKey, options.version);
  if (!versionDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Transcript not found');
  }
  const payload = await loadVersionPayload(versionDoc);
  const rawUtterances = payload?.utterances || [];
  return {
    meetingId: meeting.meetingId,
    interviewId,
    version: versionDoc.version,
    schemaVersion: versionDoc.schemaVersion ?? payload?.schemaVersion ?? 1,
    evidenceGrade: versionDoc.evidenceGrade ?? payload?.evidenceGrade ?? null,
    partialReasons: versionDoc.partialReasons ?? payload?.partialReasons ?? [],
    quality: versionDoc.quality ?? null,
    utteranceCount: versionDoc.utteranceCount ?? rawUtterances.length,
    interviewLanguage: payload?.interviewLanguage ?? meeting.interviewLanguage ?? 'en',
    transcriptVersionId: String(versionDoc._id),
    utterances: rawUtterances.map(sanitizeUtterance),
  };
};

export const getInterviewTranscriptUtteranceContext = async (
  meetingId,
  utteranceId,
  currentUser,
  options = {}
) => {
  const transcript = await getInterviewTranscript(meetingId, currentUser, { version: options.version });
  const idx = transcript.utterances.findIndex((u) => u.utteranceId === utteranceId);
  if (idx < 0) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Utterance not found');
  }
  const window = Math.min(MAX_CONTEXT_WINDOW, Math.max(1, Number(options.window) || 1));
  const start = Math.max(0, idx - window);
  const end = Math.min(transcript.utterances.length, idx + window + 1);
  return {
    meetingId: transcript.meetingId,
    interviewId: transcript.interviewId,
    version: transcript.version,
    transcriptVersionId: transcript.transcriptVersionId,
    utteranceId,
    window,
    focusIndex: idx - start,
    utterances: transcript.utterances.slice(start, end),
  };
};

export const getInterviewSummary = async (meetingId, currentUser, options = {}) => {
  const meeting = await getMeetingById(meetingId, currentUser);
  if (!meeting) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Meeting not found');
  }
  const summary = await Summary.findOne({ meetingId: meeting.meetingId }).lean();
  if (!summary) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Summary not found');
  }
  if (options.version != null && options.version !== '') {
    const v = Number(options.version);
    if (!Number.isInteger(v) || v < 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid summary version');
    }
    if (Number(summary.version || 1) !== v) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Summary not found');
    }
  }
  return {
    meetingId: meeting.meetingId,
    interviewId: meetingInterviewId(meeting),
    version: summary.version ?? 1,
    partial: !!summary.partial,
    executiveSummary: summary.executiveSummary ?? '',
    bulletSummary: summary.bulletSummary ?? [],
    actionItems: (summary.actionItems ?? []).map((a) => ({
      text: a.text,
      owner: a.owner ?? null,
      dueHint: a.dueHint ?? null,
      timestampMs: a.timestampMs ?? null,
    })),
    decisions: (summary.decisions ?? []).map((d) => ({
      text: d.text,
      timestampMs: d.timestampMs ?? null,
    })),
    blockers: summary.blockers ?? [],
    nextSteps: summary.nextSteps ?? [],
    participantsActive: (summary.participantsActive ?? []).map((p) => ({
      identity: p.identity ?? null,
      name: p.name ?? null,
      speakingMs: p.speakingMs ?? 0,
    })),
    durationMs: summary.durationMs ?? null,
    generatedAt: summary.generatedAt ?? null,
    summaryId: String(summary._id),
  };
};

export { MAX_CONTEXT_WINDOW };
