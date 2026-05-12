import SummaryDeadLetter from '../models/summaryDeadLetter.model.js';
import logger from '../config/logger.js';

export function buildDeadLetterRow(job, err) {
  return {
    meetingId: job?.data?.meetingId,
    recordingId: job?.data?.recordingId || null,
    jobId: String(job?.id),
    attempts: job?.attemptsMade ?? 0,
    lastError: err?.message || 'unknown',
    lastStack: err?.stack || null,
    payload: job?.data || {},
  };
}

export async function writeDeadLetter(job, err) {
  const row = buildDeadLetterRow(job, err);
  try {
    await SummaryDeadLetter.findOneAndUpdate(
      { jobId: row.jobId },
      { $setOnInsert: row, $set: { movedToDlqAt: new Date() } },
      { upsert: true }
    );
    logger.error('[DLQ] job moved to dead-letter', {
      meetingId: row.meetingId,
      jobId: row.jobId,
      attempts: row.attempts,
    });
  } catch (writeErr) {
    logger.error('[DLQ] failed to write row', { error: writeErr.message });
  }
}
