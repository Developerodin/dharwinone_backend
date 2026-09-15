import { writeAtsAudit } from '../services/atsAudit.service.js';

const VIEW_DEDUP_MS = 10 * 60 * 1000;
const recentViews = new Map();

/**
 * ponytail: per-process 10-minute window; upgrade to Redis SET NX EX when several backend instances need a shared window.
 */
export const shouldEmitInterviewViewAudit = (actorId, action, resourceId) => {
  const key = `${String(actorId)}|${String(action)}|${String(resourceId)}`;
  const now = Date.now();
  const prev = recentViews.get(key);
  if (prev != null && now - prev < VIEW_DEDUP_MS) return false;
  recentViews.set(key, now);
  return true;
};

export const writeDedupedInterviewViewAudit = async (actorId, params, req) => {
  if (!shouldEmitInterviewViewAudit(actorId, params.action, params.entityId)) return null;
  return writeAtsAudit(actorId, params, req);
};
