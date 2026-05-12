import catchAsync from '../utils/catchAsync.js';
import AgentDispatch from '../models/agentDispatch.model.js';
import SummaryDeadLetter from '../models/summaryDeadLetter.model.js';
import TranscriptSegment from '../models/transcriptSegment.model.js';
import Summary from '../models/summary.model.js';
import { getSummaryQueue } from '../queues/summaryQueue.js';

export const aiHealth = catchAsync(async (_req, res) => {
  const q = getSummaryQueue();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeDispatches,
    queueWaiting,
    queueActive,
    queueDelayed,
    queueFailedLast24h,
    dlqDepth,
    transcriptSegments24h,
    sumCost,
  ] = await Promise.all([
    AgentDispatch.countDocuments({ status: { $in: ['requested', 'running'] } }),
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getDelayedCount(),
    SummaryDeadLetter.countDocuments({ movedToDlqAt: { $gte: since24h } }),
    SummaryDeadLetter.countDocuments({ replayedAt: null }),
    TranscriptSegment.countDocuments({ createdAt: { $gte: since24h } }),
    Summary.aggregate([
      { $match: { generatedAt: { $gte: since24h } } },
      { $group: { _id: null, llmCostUsd24h: { $sum: '$llmCostUsd' } } },
    ]),
  ]);

  const llmCostUsd24h = sumCost[0]?.llmCostUsd24h || 0;

  return res.json({
    activeDispatches,
    queueWaiting,
    queueActive,
    queueDelayed,
    queueFailedLast24h,
    dlqDepth,
    transcriptSegments24h,
    llmCostUsd24h,
  });
});
