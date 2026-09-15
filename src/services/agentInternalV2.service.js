import httpStatus from 'http-status';
import TranscriptSession from '../models/transcriptSession.model.js';
import TranscriptBatch from '../models/transcriptBatch.model.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import Recording from '../models/recording.model.js';
import Meeting from '../models/meeting.model.js';
import logger from '../config/logger.js';
import { enqueueFinalize } from '../queues/summaryQueue.js';
import {
  computeMissingBatchSeqs,
  sessionFinalizeState,
  utteranceIdsHash,
} from './agentInternalV2.helpers.js';
import { meetingInterviewSnapshot, resolveSpeakerFromRoster } from './participantRoster.service.js';
import { getMeetingByMeetingId } from './meetingLookup.service.js';

function findRun(session, runId) {
  return session.runs.find((r) => r.runId === runId);
}

async function upsertSession({ dispatchKey, meetingId, recordingId }) {
  const filter = { dispatchKey };
  const meeting = await getMeetingByMeetingId(meetingId);
  const snapshot = meetingInterviewSnapshot(meeting) || {};
  const update = {
    $setOnInsert: {
      dispatchKey,
      meetingId,
      recordingId: recordingId || null,
      interviewId: snapshot.interviewId || null,
      applicationId: snapshot.applicationId || null,
      jobId: snapshot.jobId || null,
      candidateId: snapshot.candidateId || null,
      round: snapshot.round || null,
      interviewLanguage: snapshot.interviewLanguage || 'en',
      runs: [],
      status: 'open',
    },
  };
  try {
    return await TranscriptSession.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (err) {
    // Two first calls for the same dispatch raced on the unique dispatchKey; the other one created it.
    if (err?.code === 11000) return TranscriptSession.findOne(filter);
    throw err;
  }
}

export async function registerRun({ dispatch, runId, body }) {
  const { meetingId, recordingId, dispatchKey } = dispatch;
  const session = await upsertSession({ dispatchKey, meetingId, recordingId });

  // Atomic and idempotent: a retried or concurrent registration of the same runId adds nothing.
  await TranscriptSession.updateOne(
    { _id: session._id, 'runs.runId': { $ne: runId } },
    {
      $push: {
        runs: {
          runId,
          agentIdentity: body.agentIdentity,
          agentName: dispatch.agentName,
          protocolVersion: body.protocolVersion,
          agentBuild: body.agentBuild,
          sttProvider: body.sttProvider,
          sttModel: body.sttModel,
          language: body.language || 'en',
          startedAtEpochMs: body.startedAtEpochMs,
          status: 'open',
          lastHeartbeatAt: new Date(),
        },
      },
    }
  );

  await AgentDispatch.findByIdAndUpdate(dispatch.id, {
    $set: {
      status: 'running',
      joinedAt: new Date(),
      lastHeartbeat: new Date(),
      agentIdentity: body.agentIdentity,
    },
  });

  await Recording.findOneAndUpdate(
    {
      ...(recordingId ? { _id: recordingId } : { meetingId }),
      aiProcessingStatus: 'dispatching',
    },
    { $set: { aiProcessingStatus: 'transcribing' } }
  );

  return { sessionId: session._id, runStatus: 'open' };
}

function duplicateUtteranceIds(utterances) {
  const seen = new Set();
  for (const u of utterances) {
    if (seen.has(u.utteranceId)) return u.utteranceId;
    seen.add(u.utteranceId);
  }
  return null;
}

export async function ingestTranscriptBatch({ dispatch, runId, batchSeq, utterances }) {
  const dup = duplicateUtteranceIds(utterances);
  if (dup) {
    return { status: httpStatus.BAD_REQUEST, body: { message: 'duplicate_utterance_id', utteranceId: dup } };
  }

  const session = await TranscriptSession.findOne({ dispatchKey: dispatch.dispatchKey });
  if (!session) {
    return { status: httpStatus.CONFLICT, body: { message: 'run_not_registered' } };
  }
  const run = findRun(session, runId);
  if (!run) {
    return { status: httpStatus.CONFLICT, body: { message: 'run_not_registered' } };
  }

  const hash = utteranceIdsHash(utterances);
  const n = utterances.length;

  const meeting = await Meeting.findOne({ meetingId: dispatch.meetingId }).select('participantRoster').lean();
  const roster = meeting?.participantRoster || [];
  const enriched = utterances.map((u) => {
    const { speakerRole, speakerRef, roleAssurance } = resolveSpeakerFromRoster(roster, u.participantIdentity);
    return {
      ...u,
      speakerRole,
      speakerRef: speakerRef ? `${speakerRef.kind}:${speakerRef.id}` : null,
      roleAssurance,
    };
  });

  try {
    await TranscriptBatch.create({
      sessionId: session._id,
      runId,
      batchSeq,
      meetingId: dispatch.meetingId,
      recordingId: dispatch.recordingId || null,
      utteranceIdsHash: hash,
      utterances: enriched,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await TranscriptBatch.findOne({
        sessionId: session._id,
        runId,
        batchSeq,
      }).lean();
      if (existing?.utteranceIdsHash === hash) {
        return { status: httpStatus.OK, body: { stored: 0, duplicates: n } };
      }
      return { status: httpStatus.CONFLICT, body: { message: 'batch_conflict' } };
    }
    throw err;
  }

  // Atomic per-run update: concurrent batches (e.g. finalize resends overlapping the flush loop) must not lose counts.
  await TranscriptSession.updateOne(
    { _id: session._id, 'runs.runId': runId },
    {
      $addToSet: { 'runs.$.ackedBatchSeqs': batchSeq },
      $inc: { 'runs.$.batchCount': 1, 'runs.$.utteranceCount': n },
      $set: { 'runs.$.lastHeartbeatAt': new Date() },
    }
  );

  await AgentDispatch.findByIdAndUpdate(dispatch.id, {
    $set: { lastSegmentSentAt: new Date(), lastHeartbeat: new Date() },
  });

  return { status: httpStatus.OK, body: { stored: n, duplicates: 0 } };
}

export async function heartbeatV2({ dispatch, runId }) {
  const session = await TranscriptSession.findOne({ dispatchKey: dispatch.dispatchKey });
  if (session) {
    const runIdx = session.runs.findIndex((r) => r.runId === runId);
    if (runIdx >= 0) {
      await TranscriptSession.updateOne(
        { _id: session._id },
        { $set: { [`runs.${runIdx}.lastHeartbeatAt`]: new Date() } }
      );
    }
  }
  await AgentDispatch.findByIdAndUpdate(dispatch.id, { $set: { lastHeartbeat: new Date() } });
}

async function storedBatchSeqsForRun(sessionId, runId) {
  const rows = await TranscriptBatch.find({ sessionId, runId }).select('batchSeq').lean();
  return rows.map((r) => r.batchSeq);
}

export async function finalizeV2Run({ dispatch, body }) {
  const { runId, ackedBatchSeqs, utteranceCount, sttStreamClosures, reason } = body;
  const session = await TranscriptSession.findOne({ dispatchKey: dispatch.dispatchKey });
  if (!session) {
    return { status: httpStatus.CONFLICT, body: { message: 'run_not_registered' } };
  }
  const runIdx = session.runs.findIndex((r) => r.runId === runId);
  if (runIdx < 0) {
    return { status: httpStatus.CONFLICT, body: { message: 'run_not_registered' } };
  }

  // A repeated finalize for an already finalized run must not downgrade it; just report the session state.
  if (session.runs[runIdx].status === 'finalized') {
    return maybeEnqueueSessionSummary(session, dispatch);
  }

  // `lost` is allowed here: a late finalize from an agent the sweeper gave up on revives its run.
  await TranscriptSession.updateOne(
    { _id: session._id, 'runs.runId': runId },
    {
      $set: {
        'runs.$.status': 'finalize_requested',
        'runs.$.sttStreamClosures': sttStreamClosures,
        'runs.$.finalizeReason': reason,
        'runs.$.ackedBatchSeqs': [...new Set(ackedBatchSeqs)],
        'runs.$.utteranceCount': utteranceCount,
        'runs.$.lastHeartbeatAt': new Date(),
      },
    }
  );

  const stored = await storedBatchSeqsForRun(session._id, runId);
  const missing = computeMissingBatchSeqs(ackedBatchSeqs, stored);
  if (missing.length) {
    await TranscriptSession.updateOne(
      { _id: session._id, 'runs.runId': runId },
      { $set: { 'runs.$.missingBatchSeqs': missing } }
    );
    return { status: httpStatus.CONFLICT, body: { message: 'missing_batches', missing } };
  }

  await TranscriptSession.updateOne(
    { _id: session._id, runs: { $elemMatch: { runId, status: 'finalize_requested' } } },
    { $set: { 'runs.$.status': 'finalized', 'runs.$.endedAtEpochMs': Date.now(), 'runs.$.missingBatchSeqs': [] } }
  );

  // The dispatch is completed in maybeEnqueueSessionSummary once every run is terminal; completing it here would
  // 401 a second run (crash re-run) that is still sending batches.
  const fresh = await TranscriptSession.findById(session._id);
  return maybeEnqueueSessionSummary(fresh, dispatch);
}

function buildPartialReasons(runs) {
  const reasons = [];
  if (runs.some((r) => (r.sttStreamClosures || 0) > 0)) reasons.push('stt_stream_closed');
  if (runs.some((r) => r.finalizeReason && r.finalizeReason !== 'shutdown')) reasons.push('deadline');
  if (runs.some((r) => r.status === 'lost')) reasons.push('agent_lost');
  return reasons;
}

export async function maybeEnqueueSessionSummary(session, dispatch) {
  if (!session) {
    return { status: httpStatus.ACCEPTED, body: { status: 'waiting_for_runs' } };
  }
  const state = sessionFinalizeState(session.runs);
  if (state === 'waiting') {
    return { status: httpStatus.ACCEPTED, body: { status: 'waiting_for_runs' } };
  }
  if (state === 'all_lost') {
    // An agent that crashed after sending batches still yields a partial summary; only an empty session fails.
    const batchCount = await TranscriptBatch.countDocuments({ sessionId: session._id });
    if (batchCount === 0) {
      await TranscriptSession.findByIdAndUpdate(session._id, {
        $set: { status: 'failed', partial: true },
        $addToSet: { partialReasons: 'agent_lost' },
      });
      await AgentDispatch.updateOne(
        { _id: dispatch.id, status: { $in: ['requested', 'running'] } },
        { $set: { status: 'failed', leftAt: new Date(), error: 'all_runs_lost' } }
      );
      await Recording.findOneAndUpdate(
        {
          ...(dispatch.recordingId ? { _id: dispatch.recordingId } : { meetingId: dispatch.meetingId }),
          aiProcessingStatus: { $in: ['dispatching', 'transcribing'] },
        },
        { $set: { aiProcessingStatus: 'failed', aiProcessingError: 'agent_lost' } }
      );
      return { status: httpStatus.ACCEPTED, body: { status: 'failed' } };
    }
  }

  const partialReasons = buildPartialReasons(session.runs);
  const partial = partialReasons.length > 0 || session.partial;

  if (session.status === 'summary_queued' && session.summaryJobId) {
    return { status: httpStatus.ACCEPTED, body: { status: 'queued', jobId: session.summaryJobId } };
  }

  const finalized = await TranscriptSession.findOneAndUpdate(
    { _id: session._id, status: { $in: ['open', 'finalize_requested', 'finalized'] } },
    {
      $set: {
        status: 'finalized',
        partial,
        partialReasons: [...new Set([...(session.partialReasons || []), ...partialReasons])],
      },
    },
    { new: true }
  );
  if (!finalized) {
    const cur = await TranscriptSession.findById(session._id).lean();
    if (cur?.summaryJobId) {
      return { status: httpStatus.ACCEPTED, body: { status: 'queued', jobId: cur.summaryJobId } };
    }
    return { status: httpStatus.ACCEPTED, body: { status: 'waiting_for_runs' } };
  }

  try {
    const job = await enqueueFinalize({
      meetingId: dispatch.meetingId,
      recordingId: dispatch.recordingId,
      segmentShortfall: partial,
    });
    await TranscriptSession.findByIdAndUpdate(session._id, {
      $set: {
        status: 'summary_queued',
        summaryQueuedAt: new Date(),
        summaryJobId: job.id,
      },
    });
    await AgentDispatch.updateOne(
      { _id: dispatch.id, status: { $in: ['requested', 'running'] } },
      { $set: { status: 'completed', leftAt: new Date() } }
    );
    return { status: httpStatus.ACCEPTED, body: { status: 'queued', jobId: job.id } };
  } catch (err) {
    logger.error('[AgentInternalV2] enqueue summary failed', { error: err.message });
    throw err;
  }
}
