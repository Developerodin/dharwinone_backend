import { partialRedis } from '../config/redis.js';
import logger from '../config/logger.js';

const STREAM_MAXLEN = 500;
const TTL_SECONDS = 5 * 60;

export function buildPartialKey(meetingId) {
  return `pt:${meetingId}`;
}

export function buildMetaKey(meetingId) {
  return `pt:${meetingId}:meta`;
}

export async function appendPartials(meetingId, partials = []) {
  if (!partials.length) return { added: 0 };
  const client = partialRedis();
  const key = buildPartialKey(meetingId);
  const meta = buildMetaKey(meetingId);
  const pipe = client.pipeline();
  for (const p of partials) {
    pipe.xadd(
      key,
      'MAXLEN',
      '~',
      String(STREAM_MAXLEN),
      '*',
      'speaker',
      String(p.speaker || ''),
      'speakerName',
      String(p.speakerName || ''),
      'text',
      String(p.text || ''),
      'startMs',
      String(p.startMs || 0),
      'endMs',
      String(p.endMs || 0),
      'confidence',
      String(p.confidence ?? '')
    );
  }
  pipe.expire(key, TTL_SECONDS);
  pipe.hset(meta, 'lastInterimAt', String(Date.now()));
  pipe.expire(meta, TTL_SECONDS);
  try {
    await pipe.exec();
    return { added: partials.length };
  } catch (err) {
    logger.warn('[PartialTranscript] redis xadd failed', { meetingId, error: err.message });
    return { added: 0, error: err.message };
  }
}

export async function clearPartials(meetingId) {
  try {
    const client = partialRedis();
    await client.del(buildPartialKey(meetingId), buildMetaKey(meetingId));
  } catch (err) {
    logger.warn('[PartialTranscript] clear failed', { meetingId, error: err.message });
  }
}
