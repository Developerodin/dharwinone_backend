// uat.dharwin.backend/src/services/chatAssistant/roleRegistry.js
//
// DB-driven role registry: a 60s cache of active roles, used to tag role ids
// with their slug / display name (Sage's person profiles).

import mongoose from 'mongoose';
import Role, { slugifyRole } from '../../models/role.model.js';

const TTL_MS = 60000;

/**
 * Bypass live DB calls when mongoose isn't connected (test environments,
 * boot before connect). The registry would otherwise hang waiting on
 * mongoose's bufferCommands queue.
 */
function isMongooseReady() {
  return mongoose.connection?.readyState === 1;
}

let cache = null;
let cacheExpiry = 0;
let inflight = null;

const tokenize = (s) => slugifyRole(s);

function buildIndex(docs) {
  const byId = new Map();
  for (const d of docs) byId.set(String(d._id), d);
  return { byId, all: docs, loadedAt: Date.now() };
}

/** Load (or return cached) role registry. Pass force=true after a mutation. */
export async function loadRoleRegistry({ force = false, RoleModel = Role } = {}) {
  if (!force && cache && Date.now() < cacheExpiry) return cache;
  if (inflight) return inflight;
  // When mongoose isn't connected (boot, tests with no DB), don't block on a
  // hanging find() — return an empty registry. Do NOT cache it: a request
  // landing in the ~2s window between process start and connect used to poison
  // the cache for the full TTL. An empty registry makes tagRoleSlugs return
  // nothing, so every person lookup answered kind:'unavailable'
  // ("I couldn't reach the directory just now") for 60s after every restart.
  // The readyState check is in-process, so re-checking per call costs nothing.
  if (RoleModel === Role && !isMongooseReady()) {
    return buildIndex([]);
  }
  inflight = (async () => {
    const docs = await RoleModel.find(
      { status: 'active' },
      { _id: 1, name: 1, slug: 1, aliases: 1, previousNames: 1, status: 1 }
    ).lean();
    cache = buildIndex(docs);
    cacheExpiry = Date.now() + TTL_MS;
    return cache;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Drop the cached registry. Call from Role mutation hooks. */
export function bustRoleRegistry() {
  cache = null;
  cacheExpiry = 0;
}

/** Map<idString, slug> for batch role-tagging on user lists. */
export async function tagRoleSlugs(roleIds, opts = {}) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return new Map();
  const reg = await loadRoleRegistry(opts);
  const out = new Map();
  for (const rid of roleIds) {
    const d = reg.byId.get(String(rid));
    if (d) out.set(String(rid), d.slug || tokenize(d.name));
  }
  return out;
}

/** Map<idString, displayName>. */
export async function tagRoleDisplayNames(roleIds, opts = {}) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return new Map();
  const reg = await loadRoleRegistry(opts);
  const out = new Map();
  for (const rid of roleIds) {
    const d = reg.byId.get(String(rid));
    if (d) out.set(String(rid), d.name);
  }
  return out;
}
