import { AsyncLocalStorage } from 'node:async_hooks';

/** Serialize Bolna PATCH + verify + dial per agent id within one process. */
const agentChains = new Map();

/** Agent keys held by the current serialized stack (enables safe reentrant nesting). */
const activeKeys = new AsyncLocalStorage();

/**
 * @template T
 * @param {string} agentId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runSerializedForBolnaAgent(agentId, fn) {
  const key = String(agentId || 'default');
  const held = activeKeys.getStore();
  if (held?.has(key)) {
    return Promise.resolve().then(fn);
  }

  const prev = agentChains.get(key) || Promise.resolve();
  const run = prev.then(() => {
    const keys = new Set(held || []);
    keys.add(key);
    return activeKeys.run(keys, fn);
  });
  agentChains.set(key, run.catch(() => {}));
  return run;
}

/** Test seam: drop in-process chains between tests. */
export function resetBolnaAgentRunSerialization() {
  agentChains.clear();
}
