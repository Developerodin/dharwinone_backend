import crypto from 'node:crypto';
import mongoose from 'mongoose';
import BolnaAgentPromptLock from '../models/bolnaAgentPromptLock.model.js';

const DEFAULT_LEASE_MS = 120000;
const DEFAULT_MAX_WAIT_MS = 60000;
const DEFAULT_POLL_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory fallback when Mongo is not connected (unit tests). */
const memoryLocks = new Map();

function useMongoLocks() {
  return mongoose.connection?.readyState === 1;
}

function tryAcquireMemory(agentId, holder, expiresAt) {
  const now = Date.now();
  const existing = memoryLocks.get(agentId);
  if (existing && existing.expiresAt > now && existing.holder !== holder) {
    return false;
  }
  memoryLocks.set(agentId, { holder, expiresAt: expiresAt.getTime() });
  return true;
}

function releaseMemory(agentId, holder) {
  const existing = memoryLocks.get(agentId);
  if (existing?.holder === holder) {
    memoryLocks.delete(agentId);
  }
}

function createLeaseHealth() {
  return {
    healthy: true,
    error: null,
    markUnhealthy(error) {
      this.healthy = false;
      this.error = error || 'Bolna agent prompt lock lease lost.';
    },
    isHealthy() {
      return this.healthy;
    },
    /** @returns {{ ok: false, error: string } | null} */
    unhealthyResult() {
      if (this.healthy) return null;
      return { ok: false, error: this.error || 'Bolna agent prompt lock lease lost.' };
    },
  };
}

/**
 * @param {string} agentId
 * @param {{ leaseMs?: number, maxWaitMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<{ acquired: boolean, holder?: string, error?: string }>}
 */
export async function acquireBolnaAgentPromptLock(agentId, opts = {}) {
  const id = String(agentId || '').trim();
  if (!id) return { acquired: false, error: 'agentId is required.' };

  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const holder = crypto.randomUUID();
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);

    if (!useMongoLocks()) {
      if (tryAcquireMemory(id, holder, expiresAt)) {
        return { acquired: true, holder };
      }
      await sleep(pollMs);
      continue;
    }

    const claimed = await BolnaAgentPromptLock.findOneAndUpdate(
      { agentId: id, expiresAt: { $lte: now } },
      { $set: { agentId: id, holder, expiresAt } },
      { new: true }
    ).lean();
    if (claimed?.holder === holder) {
      return { acquired: true, holder };
    }

    try {
      await BolnaAgentPromptLock.create({ agentId: id, holder, expiresAt });
      return { acquired: true, holder };
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    await sleep(pollMs);
  }

  return { acquired: false, error: 'Could not acquire Bolna agent prompt lock in time.' };
}

/**
 * Extend a held lease so long PATCH/verify/dial work cannot outlive the lock.
 * @returns {Promise<boolean>} true when this holder still owns the lock
 */
export async function renewBolnaAgentPromptLock(agentId, holder, leaseMs = DEFAULT_LEASE_MS) {
  const id = String(agentId || '').trim();
  const token = String(holder || '').trim();
  if (!id || !token) return false;

  const expiresAt = new Date(Date.now() + leaseMs);

  if (!useMongoLocks()) {
    const existing = memoryLocks.get(id);
    if (existing?.holder !== token) return false;
    memoryLocks.set(id, { holder: token, expiresAt: expiresAt.getTime() });
    return true;
  }

  const renewed = await BolnaAgentPromptLock.findOneAndUpdate(
    { agentId: id, holder: token },
    { $set: { expiresAt } },
    { new: true }
  ).lean();
  return Boolean(renewed);
}

/**
 * @param {string} agentId
 * @param {string} holder
 */
export async function releaseBolnaAgentPromptLock(agentId, holder) {
  const id = String(agentId || '').trim();
  const token = String(holder || '').trim();
  if (!id || !token) return;

  if (!useMongoLocks()) {
    releaseMemory(id, token);
    return;
  }

  await BolnaAgentPromptLock.deleteOne({ agentId: id, holder: token });
}

/**
 * @template T
 * @param {string} agentId
 * @param {(lease: ReturnType<typeof createLeaseHealth>) => Promise<T>} fn
 * @param {{ leaseMs?: number, maxWaitMs?: number, pollMs?: number, keepaliveMs?: number, renewFn?: typeof renewBolnaAgentPromptLock }} [opts]
 * @returns {Promise<T | { ok: false, error: string }>}
 */
export async function withBolnaAgentPromptLock(agentId, fn, opts = {}) {
  const lock = await acquireBolnaAgentPromptLock(agentId, opts);
  if (!lock.acquired) {
    return { ok: false, error: lock.error || 'Bolna agent prompt lock busy.' };
  }

  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const keepaliveMs = opts.keepaliveMs ?? Math.max(Math.floor(leaseMs / 3), 1000);
  const holder = lock.holder;
  const renew = opts.renewFn ?? renewBolnaAgentPromptLock;
  const lease = createLeaseHealth();

  const runKeepaliveTick = async () => {
    try {
      const ok = await renew(agentId, holder, leaseMs);
      if (!ok) {
        lease.markUnhealthy('Bolna agent prompt lock lease could not be renewed.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lease.markUnhealthy(`Bolna agent prompt lock keepalive failed: ${message}`);
    }
  };

  let keepalive = null;
  if (keepaliveMs > 0) {
    keepalive = setInterval(() => {
      runKeepaliveTick();
    }, keepaliveMs);
    if (typeof keepalive.unref === 'function') keepalive.unref();
  }

  try {
    await runKeepaliveTick();
    const lostAfterInitial = lease.unhealthyResult();
    if (lostAfterInitial) return lostAfterInitial;

    const result = await fn(lease);
    const lostAfterFn = lease.unhealthyResult();
    if (lostAfterFn) return lostAfterFn;
    return result;
  } finally {
    if (keepalive) clearInterval(keepalive);
    await releaseBolnaAgentPromptLock(agentId, holder);
  }
}

/** Test seam: clear in-memory locks. */
export function resetBolnaAgentPromptLocks() {
  memoryLocks.clear();
}
