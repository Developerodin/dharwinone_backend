import IORedis from 'ioredis';
import config from './config.js';
import logger from './logger.js';

/**
 * BullMQ requires maxRetriesPerRequest = null on the connection.
 * We return a configuration object (BullMQ will instantiate ioredis internally)
 * so multiple Queue/Worker instances can spawn their own connections cleanly.
 *
 * For direct ioredis usage (partial transcripts), use the live-client helper.
 */

const parsed = (() => {
  const url = new URL(config.redis.url);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
})();

export function redisConnection() {
  return {
    ...parsed,
    db: config.redis.queueDb,
    maxRetriesPerRequest: null,
  };
}

export function redisPartialConnection() {
  return {
    ...parsed,
    db: config.redis.partialDb,
    maxRetriesPerRequest: null,
  };
}

let partialClient = null;
export function partialRedis() {
  if (partialClient) return partialClient;
  partialClient = new IORedis({ ...redisPartialConnection() });
  partialClient.on('error', (err) => logger.warn('[Redis] partial client error', { error: err.message }));
  return partialClient;
}

export async function closeRedisConnections() {
  if (partialClient) {
    try { await partialClient.quit(); } catch { /* noop */ }
    partialClient = null;
  }
}
