/** Serialize Bolna PATCH + outbound call per agent id to avoid prompt races. */
const agentChains = new Map();

export function runSerializedForBolnaAgent(agentId, fn) {
  const key = String(agentId || 'default');
  const prev = agentChains.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  agentChains.set(key, run.catch(() => {}));
  return run;
}
