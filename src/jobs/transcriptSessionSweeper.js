import TranscriptSession from '../models/transcriptSession.model.js';
import TranscriptBatch from '../models/transcriptBatch.model.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import logger from '../config/logger.js';
import { sessionFinalizeState } from '../services/agentInternalV2.helpers.js';
import { maybeEnqueueSessionSummary } from '../services/agentInternalV2.service.js';

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const STALE_RUN_MS = 5 * 60 * 1000;
const SUMMARY_RETRY_MS = 2 * 60 * 1000;

let timer = null;

function maxRunHeartbeat(session) {
  let max = 0;
  for (const r of session.runs || []) {
    const t = r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt).getTime() : 0;
    if (t > max) max = t;
  }
  return max;
}

export async function sweepTranscriptSessions() {
  const staleCutoff = new Date(Date.now() - STALE_RUN_MS);
  const openSessions = await TranscriptSession.find({
    status: { $in: ['open', 'finalize_requested'] },
    updatedAt: { $lt: staleCutoff },
  }).limit(50);

  for (const session of openSessions) {
    const lastHb = maxRunHeartbeat(session);
    if (lastHb && lastHb > staleCutoff.getTime()) continue;
    for (const run of session.runs) {
      // finalize_requested included: an agent that got 409 missing_batches and died never finalizes.
      if (run.status === 'open' || run.status === 'finalize_requested') {
        run.status = 'lost';
      }
    }
    session.partial = true;
    if (!session.partialReasons.includes('agent_lost')) {
      session.partialReasons.push('agent_lost');
    }
    // eslint-disable-next-line no-await-in-loop
    await session.save();
  }

  const readySessions = await TranscriptSession.find({
    status: { $in: ['open', 'finalize_requested'] },
  }).limit(50);
  for (const session of readySessions) {
    const state = sessionFinalizeState(session.runs);
    if (state !== 'ready' && state !== 'all_lost') continue;
    const dispatch = await AgentDispatch.findOne({ dispatchKey: session.dispatchKey });
    if (!dispatch) continue;
    // eslint-disable-next-line no-await-in-loop
    await maybeEnqueueSessionSummary(session, {
      id: dispatch._id,
      meetingId: dispatch.meetingId,
      recordingId: dispatch.recordingId,
      dispatchKey: dispatch.dispatchKey,
    });
  }

  const summaryRetryCutoff = new Date(Date.now() - SUMMARY_RETRY_MS);
  const stuckFinalized = await TranscriptSession.find({
    status: 'finalized',
    summaryQueuedAt: null,
    updatedAt: { $lt: summaryRetryCutoff },
  }).limit(50);
  for (const session of stuckFinalized) {
    const dispatch = await AgentDispatch.findOne({ dispatchKey: session.dispatchKey });
    if (!dispatch) continue;
    // eslint-disable-next-line no-await-in-loop
    await maybeEnqueueSessionSummary(session, {
      id: dispatch._id,
      meetingId: dispatch.meetingId,
      recordingId: dispatch.recordingId,
      dispatchKey: dispatch.dispatchKey,
    });
  }

  for (const session of await TranscriptSession.find({ status: { $in: ['completed', 'failed', 'summary_queued'] } })
    .sort({ updatedAt: -1 })
    .limit(20)) {
    const dispatch = await AgentDispatch.findOne({ dispatchKey: session.dispatchKey });
    if (!dispatch || !['requested', 'running'].includes(dispatch.status)) continue;
    const state = sessionFinalizeState(session.runs);
    if (state === 'ready' || session.status === 'summary_queued' || session.status === 'completed') {
      dispatch.status = 'completed';
      dispatch.leftAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await dispatch.save();
    } else if (state === 'all_lost') {
      const batchCount = await TranscriptBatch.countDocuments({ sessionId: session._id });
      if (batchCount === 0) {
        dispatch.status = 'failed';
        dispatch.error = 'all_runs_lost';
        dispatch.leftAt = new Date();
        // eslint-disable-next-line no-await-in-loop
        await dispatch.save();
      }
    }
  }
}

export function startTranscriptSessionSweeper() {
  if (timer) return;
  timer = setInterval(() => {
    sweepTranscriptSessions().catch((err) => {
      logger.warn('[TranscriptSessionSweeper] sweep failed', { error: err.message });
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  logger.info('[TranscriptSessionSweeper] started');
}

export function stopTranscriptSessionSweeper() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
