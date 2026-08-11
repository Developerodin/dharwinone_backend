// Parallel user + role resolution for conversational "tell me about X" queries.

import { slugifyRole } from '../../../models/role.model.js';
import { resolveUserEntity as realResolveUser } from '../entityResolver.js';
import { loadRoleRegistry as realLoadRegistry, tagRoleDisplayNames as realNames } from '../roleRegistry.js';

const tokenize = (s) => String(s || '').toLowerCase().split(/[\s,._-]+/).filter(Boolean);

function roleNamesOf(doc) {
  const out = [doc.name, doc.slug, ...(doc.aliases || [])];
  for (const p of doc.previousNames || []) {
    if (p?.name) out.push(p.name);
  }
  return out.filter(Boolean);
}

function scoreRoleMatch(query, doc) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;

  const qToken = slugifyRole(q);
  const slug = doc.slug || slugifyRole(doc.name);
  if (slug === qToken) return 1;
  for (const a of doc.aliases || []) {
    if (slugifyRole(a) === qToken) return 1;
  }

  const hay = roleNamesOf(doc).join(' ').toLowerCase();
  if (hay === q) return 1;
  if (hay.includes(q) || q.includes(hay)) return 0.85;

  const qTokens = tokenize(q);
  const dTokens = tokenize(hay);
  let hits = 0;
  for (const qt of qTokens) {
    if (dTokens.some((dt) => dt === qt || dt.startsWith(qt) || qt.startsWith(dt))) hits += 1;
  }
  if (hits && qTokens.length) return Math.min(0.9, (hits / qTokens.length) * 0.85);
  return 0;
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @returns {Promise<
 *   | { kind: 'unique', entityType: 'role', entity: { roleId: any, name: string, slug: string|null, score: number } }
 *   | { kind: 'unique', entityType: 'user', entity: object }
 *   | { kind: 'ambiguous', matches: Array<{ kind: 'user'|'role', userId?: any, roleId?: any, name: string, roles?: string[], score: number }> }
 *   | { kind: 'notFound', entityType: null }
 *   | { kind: 'user_only_ambiguous', matches: object[] }
 * >}
 */
export async function resolveRoleCandidates(query, opts = {}) {
  const loadRegistry = opts.loadRoleRegistry ?? realLoadRegistry;
  const trimmed = String(query || '').trim();
  if (!trimmed) return { kind: 'notFound' };

  const reg = await loadRegistry(opts);
  const scored = reg.all
    .map((d) => ({ doc: d, score: scoreRoleMatch(trimmed, d) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: 'notFound' };

  const top = scored[0];
  const second = scored[1];
  if (scored.length === 1 || (second && top.score - second.score >= 0.2)) {
    return {
      kind: 'unique',
      entityType: 'role',
      entity: {
        roleId: top.doc._id,
        name: top.doc.name,
        slug: top.doc.slug || slugifyRole(top.doc.name),
        score: top.score,
      },
    };
  }

  return {
    kind: 'ambiguous',
    matches: scored.slice(0, 5).map(({ doc, score }) => ({
      kind: 'role',
      roleId: doc._id,
      name: doc.name,
      score,
    })),
  };
}

/**
 * @param {object} args
 * @param {string} args.subject
 * @param {'role'|'person'} [args.intent='person']
 * @param {object} [args.viewer]
 * @param {object} [args.deps]
 */
export async function resolveConversationalEntity({
  subject,
  intent = 'person',
  viewer = null,
  deps = {},
}) {
  const resolveUser = deps.resolveUserEntity ?? realResolveUser;
  const loadRegistry = deps.loadRoleRegistry ?? realLoadRegistry;
  const nameTagger = deps.tagRoleDisplayNames ?? realNames;

  const trimmed = String(subject || '').trim();
  if (!trimmed) return { kind: 'notFound', entityType: null };

  if (intent === 'role') {
    const roleRes = await resolveRoleCandidates(trimmed, { loadRoleRegistry: loadRegistry, ...deps });
    if (roleRes.kind === 'unique') return roleRes;
    if (roleRes.kind === 'ambiguous') {
      return { kind: 'ambiguous', entityType: 'role', matches: roleRes.matches };
    }
    return { kind: 'notFound', entityType: 'role' };
  }

  const [userRes, roleRes] = await Promise.all([
    resolveUser(trimmed, { viewer }),
    resolveRoleCandidates(trimmed, { loadRoleRegistry: loadRegistry, ...deps }),
  ]);

  const userHit = userRes.kind === 'unique' || userRes.kind === 'ambiguous';
  const roleHit = roleRes.kind === 'unique' || roleRes.kind === 'ambiguous';

  if (userHit && roleHit) {
    /** @type {Array<{ kind: 'user'|'role', userId?: any, roleId?: any, name: string, roles?: string[], score: number }>} */
    const matches = [];

    if (userRes.kind === 'unique') {
      const names = await nameTagger(userRes.match.roleIds || []);
      matches.push({
        kind: 'user',
        userId: userRes.match.userId,
        name: userRes.match.name,
        roles: [...names.values()],
        score: userRes.match.score ?? 1,
      });
    } else {
      for (const m of userRes.matches) {
        const names = await nameTagger(m.roleIds || []);
        matches.push({
          kind: 'user',
          userId: m.userId,
          name: m.name,
          roles: [...names.values()],
          score: m.score ?? 0,
        });
      }
    }

    if (roleRes.kind === 'unique') {
      matches.push({
        kind: 'role',
        roleId: roleRes.entity.roleId,
        name: roleRes.entity.name,
        score: roleRes.entity.score ?? 1,
      });
    } else {
      matches.push(...roleRes.matches);
    }

    matches.sort((a, b) => b.score - a.score);
    return { kind: 'ambiguous', entityType: 'mixed', matches };
  }

  if (userRes.kind === 'unique') {
    return { kind: 'unique', entityType: 'user', entity: userRes.match };
  }
  if (roleRes.kind === 'unique') {
    return { kind: 'unique', entityType: 'role', entity: roleRes.entity };
  }

  if (userRes.kind === 'ambiguous') {
    return { kind: 'user_only_ambiguous', entityType: 'user', matches: userRes.matches };
  }
  if (roleRes.kind === 'ambiguous') {
    return { kind: 'ambiguous', entityType: 'role', matches: roleRes.matches };
  }

  return { kind: 'notFound', entityType: null };
}
