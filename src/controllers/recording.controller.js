import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import recordingService from '../services/recording.service.js';

const listAll = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'limit', 'status', 'q', 'dateFrom', 'dateTo', 'source']);
  const result = await recordingService.listAll(options, req.user);
  res.send(result);
});

/**
 * Sync recordings from LiveKit egress: pulls every egress LiveKit knows about
 * and upserts our DB so each row reflects the real LiveKit status. Idempotent.
 */
const syncFromLiveKit = catchAsync(async (req, res) => {
  const result = await recordingService.syncFromLiveKit();
  res.send(result);
});

/**
 * GET /recordings/:recordingId/transcript — return all transcript segments for
 * a recording (ordered by sequenceNumber). Empty `segments[]` if none ingested.
 */
const getTranscript = catchAsync(async (req, res) => {
  const result = await recordingService.getTranscriptByRecordingId(req.params.recordingId, req.user);
  res.send(result);
});

export { listAll, syncFromLiveKit, getTranscript };
