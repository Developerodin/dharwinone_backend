/**
 * In-memory registry of per-call Bolna clones this process created.
 * CallRecord.ownedClone is the durable marker the webhook path also checks.
 * Configured template ids stay owned via config.bolna.allAgentIds. Unknown ids do not.
 */
const ownedCloneIds = new Set();

export function registerOwnedCloneAgent(agentId) {
  const id = String(agentId || '').trim();
  if (id) ownedCloneIds.add(id);
}

export function unregisterOwnedCloneAgent(agentId) {
  ownedCloneIds.delete(String(agentId || '').trim());
}

export function isRegisteredCloneAgent(agentId) {
  return ownedCloneIds.has(String(agentId || '').trim());
}
