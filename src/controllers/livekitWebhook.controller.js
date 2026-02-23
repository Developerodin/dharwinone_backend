import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import Recording from '../models/recording.model.js';
import logger from '../config/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.resolve(__dirname, '../../recordings');

/**
 * Save webhook payload to local recordings folder (JSON file).
 */
const savePayloadLocally = async (payload) => {
  try {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
    const info = payload?.egressInfo || {};
    const egressId = info.egressId || info.id || 'unknown';
    const ts = Date.now();
    const filename = `egress-${egressId}-${ts}.json`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    const data = {
      receivedAt: new Date().toISOString(),
      ...payload,
    };
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    logger.info('[LiveKit Webhook] Saved locally', { filepath });
  } catch (err) {
    logger.warn('[LiveKit Webhook] Failed to save locally', { error: err.message });
  }
};

/**
 * Handle LiveKit Egress webhook events.
 * Configure this URL in LiveKit Cloud: Settings > Webhooks
 * or in server.yaml (self-hosted): webhook.urls
 *
 * Full URL example: https://your-backend.com/v1/webhooks/livekit-egress
 */
const receiveLiveKitEgressWebhook = catchAsync(async (req, res) => {
  const payload = req.body;
  const event = payload?.event;

  logger.info('[LiveKit Webhook] Received', { event, egressId: payload?.egressInfo?.egressId });

  // Store webhook payload locally (recordings folder)
  await savePayloadLocally(payload);

  if (event === 'egress_ended') {
    const info = payload.egressInfo || {};
    const egressId = info.egressId || info.id;

    if (!egressId) {
      logger.warn('[LiveKit Webhook] egress_ended missing egressId', payload);
      return res.status(httpStatus.OK).json({ status: 'received' });
    }

    // endedAt: Unix timestamp (seconds) from LiveKit
    const completedAt = info.endedAt
      ? new Date(Number(info.endedAt) * 1000)
      : new Date();

    // Optionally get file path from file results (first file output)
    const fileResults = info.fileResults || info.fileResultsList;
    const filePath =
      fileResults?.[0]?.filename ||
      fileResults?.[0]?.filepath ||
      fileResults?.[0]?.location;

    const update = {
      status: 'completed',
      completedAt,
      ...(filePath && { filePath }),
    };

    const recording = await Recording.findOneAndUpdate(
      { egressId },
      update,
      { new: true }
    );

    if (recording) {
      logger.info('[LiveKit Webhook] Recording updated', {
        egressId,
        status: 'completed',
        completedAt: update.completedAt,
      });
    } else {
      logger.warn('[LiveKit Webhook] No Recording found for egressId', { egressId });
    }
  } else if (event === 'egress_started' || event === 'egress_updated') {
    // Optional: log or handle started/updated events
    logger.debug('[LiveKit Webhook] Event', { event, egressId: payload?.egressInfo?.egressId });
  }

  res.status(httpStatus.OK).json({ status: 'received' });
});

export { receiveLiveKitEgressWebhook };
