// uat.dharwin.backend/src/services/chatAssistant/roleRegistry.js
//
// DB-driven role registry. Single source of truth that replaces hardcoded
// ALIAS_GROUPS / VALID_ROLES / ROLE_ALIAS_MAP. New roles, renames, and alias
// edits propagate automatically — chatbot, classifier, and tool router all
// resolve role names through this module.

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
  const bySlug = new Map();
  const byId = new Map();
  for (const d of docs) {
    byId.set(String(d._id), d);
    const tokens = new Set();
    if (d.slug) tokens.add(d.slug);
    if (d.name) tokens.add(tokenize(d.name));
    for (const a of d.aliases || []) {
      const t = tokenize(a);
      if (t) tokens.add(t);
    }
    for (const p of d.previousNames || []) {
      const t = tokenize(p?.name || '');
      if (t) tokens.add(t);
    }
    for (const t of tokens) {
      if (!bySlug.has(t)) bySlug.set(t, []);
      bySlug.get(t).push(d);
    }
  }
  return { bySlug, byId, all: docs, loadedAt: Date.now() };
}

/** Load (or return cached) role registry. Pass force=true after a mutation. */
export async function loadRoleRegistry({ force = false, RoleModel = Role } = {}) {
  if (!force && cache && Date.now() < cacheExpiry) return cache;
  if (inflight) return inflight;
  // When mongoose isn't connected (boot, tests with no DB), don't block on a
  // hanging find() — return an empty registry. The cache TTL still applies
  // so a real connect-then-query happens within 60s once the DB comes up.
  if (RoleModel === Role && !isMongooseReady()) {
    cache = buildIndex([]);
    cacheExpiry = Date.now() + TTL_MS;
    return cache;
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

/**
 * Resolve free-form role input (slug, current name, alias, or previous name)
 * to canonical role docs. Multiple matches occur when duplicate Role docs
 * share an alias (legacy 'Agent' + 'agent') — caller treats as a set.
 */
export async function resolveRole(input, opts = {}) {
  if (!input) return { ids: [], names: [], slugs: [], canonical: null, match: null };
  const reg = await loadRoleRegistry(opts);
  const token = tokenize(input);
  const docs = reg.bySlug.get(token) || [];
  if (docs.length) {
    return {
      ids: docs.map((d) => d._id),
      names: docs.map((d) => d.name),
      slugs: docs.map((d) => d.slug || tokenize(d.name)),
      canonical: docs[0].slug || tokenize(docs[0].name),
      match: 'exact',
    };
  }
  const lower = String(input).trim().toLowerCase();
  const partial = reg.all.filter((d) => d.name.toLowerCase().includes(lower));
  if (partial.length === 1) {
    const d = partial[0];
    return {
      ids: [d._id],
      names: [d.name],
      slugs: [d.slug || tokenize(d.name)],
      canonical: d.slug || tokenize(d.name),
      match: 'alias',
    };
  }
  return { ids: [], names: [], slugs: [], canonical: null, match: null };
}

/** Public list of available role slugs + display names. */
export async function listRoleSlugs(opts = {}) {
  const reg = await loadRoleRegistry(opts);
  return reg.all.map((d) => ({
    id: String(d._id),
    slug: d.slug || tokenize(d.name),
    name: d.name,
    aliases: d.aliases || [],
  }));
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

/**
 * Synchronous resolve. Reads the current in-memory cache only — never hits
 * the DB. Returns `null` when cache is cold (boot, recently busted). Useful
 * for hot paths like extractEntities() that can't await.
 */
export function resolveRoleSync(input) {
  if (!input || !cache) return null;
  const token = tokenize(input);
  const docs = cache.bySlug.get(token);
  if (!docs?.length) return null;
  const d = docs[0];
  return {
    id: d._id,
    slug: d.slug || tokenize(d.name),
    name: d.name,
  };
}

/** Synchronous list of slugs from current cache, or null when cold. */
export function listRoleSlugsSync() {
  if (!cache) return null;
  return cache.all.map((d) => ({
    id: String(d._id),
    slug: d.slug || tokenize(d.name),
    name: d.name,
    aliases: d.aliases || [],
  }));
}

export async function snapshotRegistry(opts = {}) {
  const reg = await loadRoleRegistry(opts);
  return {
    loadedAt: reg.loadedAt,
    expiresAt: cacheExpiry,
    count: reg.all.length,
    roles: reg.all.map((d) => ({
      id: String(d._id),
      name: d.name,
      slug: d.slug,
      aliases: d.aliases || [],
      previousNames: (d.previousNames || []).map((p) => p.name),
    })),
  };
}
