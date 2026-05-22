import IORedis from 'ioredis';
import config from './config.js';
import logger from './logger.js';

/**
 * BullMQ requires maxRetriesPerRequest = null on the connection.
 * We return a configuration object (BullMQ will instantiate ioredis internally)
 * so multiple Queue/Worker instances can spawn their own connections cleanly.
 *
 * For direct ioredis usage (partial transcripts), use the live-client helper.
 *
 * Production (Render): set REDIS_URL env var to the Render Redis internal URL,
 * e.g. redis://default:<password>@<host>:6379
 * enableReadyCheck: false prevents crashes on Render cold-start before Redis is ready.
 */

const parsed = (() => {
  const url = new URL(config.redis.url);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
  };
})();

/** Base options shared by all connection types */
const BASE_OPTS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
};

export function redisConnection() {
  return {
    ...parsed,
    ...BASE_OPTS,
    db: config.redis.queueDb,
  };
}

export function redisPartialConnection() {
  return {
    ...parsed,
    ...BASE_OPTS,
    db: config.redis.partialDb,
  };
}

let partialClient = null;
export function partialRedis() {
  if (partialClient) return partialClient;
  partialClient = new IORedis({
    ...redisPartialConnection(),
    lazyConnect: true,
  });
  partialClient.on('error', (err) => logger.warn('[Redis] partial client error', { error: err.message }));
  return partialClient;
}

export async function closeRedisConnections() {
  if (partialClient) {
    try { await partialClient.quit(); } catch { /* noop */ }
    partialClient = null;
  }
}
