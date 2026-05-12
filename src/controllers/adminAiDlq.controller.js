import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import SummaryDeadLetter from '../models/summaryDeadLetter.model.js';
import { enqueueFinalize, getSummaryQueue } from '../queues/summaryQueue.js';
import logger from '../config/logger.js';

export const listDlq = catchAsync(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const rows = await SummaryDeadLetter.find({ replayedAt: null })
    .sort({ movedToDlqAt: -1 })
    .limit(limit)
    .select('meetingId jobId attempts lastError movedToDlqAt')
    .lean();
  return res.json({ rows });
});

export const replayDlq = catchAsync(async (req, res) => {
  const { jobId } = req.params;
  const row = await SummaryDeadLetter.findOne({ jobId });
  if (!row) return res.status(httpStatus.NOT_FOUND).json({ message: 'not found' });
  const job = await enqueueFinalize({ meetingId: row.meetingId, recordingId: row.recordingId });
  row.replayedAt = new Date();
  row.replayJobId = job.id;
  await row.save();
  logger.info('[Admin DLQ] replayed', { originalJobId: jobId, newJobId: job.id });
  return res.json({ status: 'queued', jobId: job.id });
});

export const deleteDlq = catchAsync(async (req, res) => {
  const { jobId } = req.params;
  await SummaryDeadLetter.deleteOne({ jobId });
  return res.json({ status: 'deleted' });
});

export const queueStats = catchAsync(async (_req, res) => {
  const q = getSummaryQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getCompletedCount(),
    q.getFailedCount(),
    q.getDelayedCount(),
  ]);
  return res.json({ waiting, active, completed, failed, delayed });
});
