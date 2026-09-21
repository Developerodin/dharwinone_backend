import mongoose from 'mongoose';
import Meeting from '../models/meeting.model.js';
import Job from '../models/job.model.js';
import TranscriptVersion from '../models/transcriptVersion.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import InterviewEvaluation from '../models/interviewEvaluation.model.js';
import logger from '../config/logger.js';
import { readJsonFromS3 } from './aiArtifactStorage.service.js';
import { buildTranscriptOwnerKey } from './transcriptAssembly.service.js';
import { assertMeetingInScope } from './meeting.service.js';
import { generateBiasReport } from './interviewBias.openai.js';
import { applyThinTranscriptMismatch } from './interviewBias.parse.js';
import {
  decideBiasSkip,
  hasUsableScorecard,
  resolveJobIdFromMeeting,
  scorecardForPrompt,
  utterancesFromLegacySegments,
} from './interviewBias.inputs.js';
import {
  BIAS_ADVISORY_NOTICE,
  BIAS_MODEL,
  BIAS_PROMPT_VERSION,
  BIAS_SKIP_COPY,
  BIAS_SKIP_REASONS,
} from '../constants/interviewBias.js';

const MAX_LOAD_UTTERANCES = 80;

/**
 * @param {import('mongoose').Document|object} meeting
 * @returns {string}
 */
function meetingInterviewId(meeting) {
  return meeting.id || meeting._id?.toString?.() || String(meeting._id);
}

/**
 * Load latest assembled TranscriptVersion utterances from S3.
 * @param {object} meeting
 * @returns {Promise<Array<{ utteranceId?: string, speakerRole?: string, text?: string }>>}
 */
async function loadTranscriptVersionUtterances(meeting) {
  const interviewId = meetingInterviewId(meeting);
  const ownerKey = buildTranscriptOwnerKey({ interviewId, meetingId: meeting.meetingId });
  const versionDoc = await TranscriptVersion.findOne({ ownerKey }).sort({ version: -1 }).lean();
  if (!versionDoc?.s3Key) return [];
  let payload = null;
  try {
    payload = await readJsonFromS3({ key: versionDoc.s3Key });
  } catch (err) {
    logger.warn('[interviewBias] transcript S3 read failed:', err?.message || err);
    return [];
  }
  const rows = [];
  for (const u of Array.isArray(payload?.utterances) ? payload.utterances : []) {
    if (!String(u?.text || '').trim()) continue;
    rows.push({
      utteranceId: u.utteranceId,
      speakerRole: u.speakerRole,
      text: u.text,
    });
    if (rows.length >= MAX_LOAD_UTTERANCES) break;
  }
  return rows;
}

/**
 * Prefer assembled TranscriptVersion; fall back to legacy segments so recorded interviews still analyze.
 * @param {object} meeting
 * @returns {Promise<Array<{ utteranceId?: string, speakerRole?: string, text?: string }>>}
 */
export async function loadTranscriptUtterancesInternal(meeting) {
  const fromVersion = await loadTranscriptVersionUtterances(meeting);
  if (fromVersion.length) return fromVersion;
  const segments = await TranscriptSegment.find({ meetingId: meeting.meetingId })
    .sort({ sequenceNumber: 1 })
    .select('sequenceNumber utterances')
    .lean();
  return utterancesFromLegacySegments(segments, MAX_LOAD_UTTERANCES);
}

/**
 * Scorecard from the meeting embed, or panel InterviewEvaluation rows (new rubric UI).
 * @param {object} meeting
 * @returns {Promise<object|null>}
 */
export async function loadScorecardForBias(meeting) {
  if (hasUsableScorecard(meeting.interviewScorecard)) return meeting.interviewScorecard;
  const evals = await InterviewEvaluation.find({ meeting: meeting._id })
    .select('ratings comment')
    .lean();
  const ratings = [];
  const comments = [];
  for (const ev of evals || []) {
    if (typeof ev.comment === 'string' && ev.comment.trim()) comments.push(ev.comment.trim());
    for (const r of ev.ratings || []) {
      if (r?.notApplicable) continue;
      if (r?.rating == null) continue;
      ratings.push({ criterion: String(r.key || ''), rating: Number(r.rating) });
    }
  }
  const scorecard = { ratings, comment: comments.join('\n') };
  return hasUsableScorecard(scorecard) ? scorecard : meeting.interviewScorecard;
}

/**
 * @param {string|null} jobId
 * @returns {Promise<string>}
 */
export async function loadJobDescription(jobId) {
  if (!jobId) return '';
  const job = await Job.findById(jobId).select('jobDescription').lean();
  return typeof job?.jobDescription === 'string' ? job.jobDescription.trim() : '';
}

/**
 * Persist only biasCheck — never interviewResult.
 * @param {import('mongoose').Types.ObjectId|string} meetingMongoId
 * @param {object} biasCheck
 */
export async function persistBiasCheck(meetingMongoId, biasCheck) {
  await Meeting.updateOne({ _id: meetingMongoId }, { $set: { biasCheck } });
}

/**
 * Build the public DTO (no scorer PII).
 * @param {object|null|undefined} biasCheck
 * @returns {object}
 */
export function serializeBiasCheck(biasCheck) {
  if (!biasCheck || typeof biasCheck !== 'object') {
    return {
      status: null,
      skipReason: null,
      skipReasonLabel: null,
      riskLevel: null,
      flags: [],
      evidence: [],
      reasons: [],
      advisoryNotice: BIAS_ADVISORY_NOTICE,
      model: null,
      promptVersion: null,
      analyzedAt: null,
    };
  }
  const skipReason = biasCheck.skipReason || null;
  return {
    status: biasCheck.status || null,
    skipReason,
    skipReasonLabel: skipReason ? BIAS_SKIP_COPY[skipReason] || skipReason : null,
    riskLevel: biasCheck.riskLevel || null,
    flags: Array.isArray(biasCheck.flags) ? biasCheck.flags : [],
    evidence: Array.isArray(biasCheck.evidence) ? biasCheck.evidence : [],
    reasons: Array.isArray(biasCheck.reasons) ? biasCheck.reasons : [],
    advisoryNotice: biasCheck.advisoryNotice || BIAS_ADVISORY_NOTICE,
    model: biasCheck.model || null,
    promptVersion: biasCheck.promptVersion || null,
    analyzedAt: biasCheck.analyzedAt || null,
  };
}

/**
 * Stamp failed after the worker exhausts retries — never touches interviewResult.
 * @param {string} meetingId
 * @returns {Promise<void>}
 */
export async function markBiasCheckFailed(meetingId) {
  const trimmed = String(meetingId || '').trim();
  if (!trimmed || !mongoose.Types.ObjectId.isValid(trimmed)) return;
  await persistBiasCheck(trimmed, {
    status: 'failed',
    skipReason: '',
    flags: [],
    evidence: [],
    reasons: ['Automatic bias review failed. Try Re-run.'],
    advisoryNotice: BIAS_ADVISORY_NOTICE,
    model: BIAS_MODEL,
    promptVersion: BIAS_PROMPT_VERSION,
    analyzedAt: new Date(),
  });
}

/**
 * Run the bias analyzer for one meeting. Last write wins. Never writes interviewResult.
 * @param {string} meetingIdOrMongoId
 * @returns {Promise<object>}
 */
export async function analyzeInterviewBias(meetingIdOrMongoId) {
  const trimmed = String(meetingIdOrMongoId || '').trim();
  if (!trimmed) return { status: 'failed' };

  let meeting = null;
  if (
    mongoose.Types.ObjectId.isValid(trimmed) &&
    String(new mongoose.Types.ObjectId(trimmed)) === trimmed
  ) {
    meeting = await Meeting.findById(trimmed).select('+biasCheck');
  }
  if (!meeting) {
    meeting = await Meeting.findOne({ meetingId: trimmed }).select('+biasCheck');
  }
  if (!meeting) {
    logger.warn('[interviewBias] meeting not found', { meetingIdOrMongoId: trimmed });
    return { status: 'failed' };
  }

  const mongoId = meeting._id;
  const scorecard = await loadScorecardForBias(meeting);
  const stamp = {
    flags: [],
    evidence: [],
    reasons: [],
    advisoryNotice: BIAS_ADVISORY_NOTICE,
    model: BIAS_MODEL,
    promptVersion: BIAS_PROMPT_VERSION,
    analyzedAt: new Date(),
  };

  if (!hasUsableScorecard(scorecard)) {
    await persistBiasCheck(mongoId, { ...stamp, status: 'skipped', skipReason: 'no_scorecard' });
    return { status: 'skipped', skipReason: 'no_scorecard' };
  }

  const jobDescription = await loadJobDescription(resolveJobIdFromMeeting(meeting));
  if (!jobDescription) {
    await persistBiasCheck(mongoId, {
      ...stamp,
      status: 'skipped',
      skipReason: 'no_job_description',
    });
    return { status: 'skipped', skipReason: 'no_job_description' };
  }

  const utterances = await loadTranscriptUtterancesInternal(meeting);
  const skipReason = decideBiasSkip({
    hasScorecard: true,
    jobDescription,
    utterances,
  });
  if (skipReason) {
    await persistBiasCheck(mongoId, { ...stamp, status: 'skipped', skipReason });
    return { status: 'skipped', skipReason };
  }

  try {
    const report = applyThinTranscriptMismatch(
      await generateBiasReport({
        utterances,
        jobDescription,
        scorecard: scorecardForPrompt(scorecard),
        interviewResult: meeting.interviewResult,
      }),
      { utterances, interviewResult: meeting.interviewResult }
    );
    await persistBiasCheck(mongoId, {
      ...stamp,
      status: 'ready',
      skipReason: '',
      riskLevel: report.riskLevel,
      flags: report.flags,
      evidence: report.evidence,
      reasons: report.reasons,
    });
    return { status: 'ready', riskLevel: report.riskLevel };
  } catch (err) {
    const message = err?.message || String(err);
    const skip = message.includes('OPENAI_API_KEY') ? BIAS_SKIP_REASONS.llm_unavailable : '';
    logger.warn('[interviewBias] analyze failed:', message);
    await persistBiasCheck(mongoId, {
      ...stamp,
      status: skip ? 'skipped' : 'failed',
      skipReason: skip || '',
      reasons: skip ? [] : ['Automatic bias review failed. Try Re-run.'],
    });
    return { status: skip ? 'skipped' : 'failed', skipReason: skip || null };
  }
}

const BIAS_READ_SELECT =
  'tenantId createdBy hosts candidate recruiter agents emailInvites meetingId +biasCheck';

/**
 * Staff GET — scoped, no createdBy/scoredBy populate.
 * @param {string} id
 * @param {object} currentUser
 */
export async function getInterviewBiasCheck(id, currentUser) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return null;
  let meeting = null;
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    meeting = await Meeting.findById(trimmed).select(BIAS_READ_SELECT);
  }
  if (!meeting) {
    meeting = await Meeting.findOne({ meetingId: trimmed }).select(BIAS_READ_SELECT);
  }
  if (!meeting) return null;
  await assertMeetingInScope(meeting, currentUser);
  return serializeBiasCheck(meeting.biasCheck);
}
