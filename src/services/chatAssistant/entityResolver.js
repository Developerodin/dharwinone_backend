// uat.dharwin.backend/src/services/chatAssistant/entityResolver.js
//
// Multi-source person resolver. Replaces the regex-on-fullName pattern in
// chatAssistant.service.js#resolveEmployeeMatch. Searches User AND Employee
// across `name`, `email`, `phoneNumber`, `employeeId`, `aliases`,
// `previousNames`. Returns kind: unique | ambiguous | notFound with a
// confidence score so the LLM can ask a clarification question rather than
// silently picking the wrong row.
//
// Soft-delete protection: only `User.status === 'active'` rows participate.
// Orphan employees (User row gone or non-active) surface as `orphan: true`
// matches so deleted-user lookups don't silently disappear, but the LLM can
// flag them as inactive in its reply.

import User from '../../models/user.model.js';
import Employee from '../../models/employee.model.js';
import { visibleUserStatusClause, canUserBeVisible } from './visibilityRules.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenize = (s) => String(s || '').toLowerCase().split(/[\s,._-]+/).filter(Boolean);

function scoreMatch(query, doc) {
  const q = String(query || '').trim();
  if (!q) return 0;
  const lcQuery = q.toLowerCase();

  if ((doc.email || '').toLowerCase() === lcQuery) return 1;
  if ((doc.employeeId || '').toLowerCase() === lcQuery) return 1;
  const phoneDigits = String(doc.phone || '').replace(/[^0-9]/g, '');
  const queryDigits = q.replace(/[^0-9]/g, '');
  if (phoneDigits && queryDigits && phoneDigits === queryDigits) return 1;

  const qTokens = tokenize(q);
  if (qTokens.length === 0) return 0;

  const dHaystack = [
    doc.name, doc.email, doc.employeeId,
    ...(doc.previousNames || []), ...(doc.aliases || []),
  ].filter(Boolean).join(' ').toLowerCase();
  const dTokens = tokenize(dHaystack);

  let prefixHits = 0;
  let exactHits = 0;
  for (const qt of qTokens) {
    if (dTokens.includes(qt)) exactHits += 1;
    else if (dTokens.some((dt) => dt.startsWith(qt))) prefixHits += 1;
  }

  const score = (exactHits * 1.0 + prefixHits * 0.7) / qTokens.length;
  const verbatim = dHaystack.includes(lcQuery) ? 0.1 : 0;
  return Math.min(1, score + verbatim);
}

/**
 * Resolve a free-form person query to a unique identity, or report ambiguity.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=10]      Max candidates returned in ambiguous payload.
 * @param {number} [opts.minScore=0.5]  Drop candidates below this score.
 * @param {number} [opts.uniqueGap=0.25] Top score must beat second by this margin
 *   to be considered unambiguous.
 * @param {boolean} [opts.includeOrphans=true] Surface orphan employees (no live User).
 * @param {object} [opts.User]      Injectable model (tests).
 * @param {object} [opts.Employee]  Injectable model (tests).
 *
 * @returns {Promise<
 *   | { kind: 'unique', match: PersonMatch }
 *   | { kind: 'ambiguous', matches: PersonMatch[] }
 *   | { kind: 'notFound' }
 * >}
 */
export async function resolveUserEntity(query, opts = {}) {
  const {
    limit = 10,
    minScore = 0.5,
    uniqueGap = 0.25,
    includeOrphans = true,
    visibility: visibilityOverride = {},
    User: UserModel = User,
    Employee: EmployeeModel = Employee,
  } = opts;

  const trimmed = String(query || '').trim();
  if (!trimmed) return { kind: 'notFound' };

  const safe = escapeRegex(trimmed);
  const compact = trimmed.replace(/[\s\-_]+/g, '');
  const safeCompact = escapeRegex(compact);

  const tokens = tokenize(trimmed).filter((t) => t.length >= 2);
  const tokenOr = tokens.map((t) => ({ name: { $regex: escapeRegex(t), $options: 'i' } }));

  const userOr = [
    { name:          { $regex: safe, $options: 'i' } },
    { email:         { $regex: safe, $options: 'i' } },
    { phoneNumber:   { $regex: safe, $options: 'i' } },
    { previousNames: { $regex: safe, $options: 'i' } },
    { aliases:       { $regex: safe, $options: 'i' } },
    ...tokenOr,
  ];
  const empOr = [
    { fullName:      { $regex: safe, $options: 'i' } },
    { employeeId:    { $regex: safe, $options: 'i' } },
    { previousNames: { $regex: safe, $options: 'i' } },
  ];
  if (compact && compact !== trimmed) {
    empOr.push({ employeeId: { $regex: safeCompact, $options: 'i' } });
  }

  const [users, employees] = await Promise.all([
    // Single source of truth — visibilityRules.visibleUserStatusClause() drives
    // every chatbot User query. Default: active+pending. Caller can opt-in
    // disabled / archived via opts.visibility.{includeDisabled,includeArchived}.
    UserModel.find({ status: visibleUserStatusClause(visibilityOverride), $or: userOr })
      .select('_id name email phoneNumber roleIds status platformSuperUser previousNames aliases location')
      .limit(50)
      .lean(),
    EmployeeModel.find({ $or: empOr })
      .select('_id fullName employeeId owner designation department previousNames')
      .limit(50)
      .lean(),
  ]);

  const empByOwner = new Map(employees.map((e) => [String(e.owner), e]));

  const merged = users.map((u) => {
    const e = empByOwner.get(String(u._id));
    return {
      userId: u._id,
      empDocId: e?._id || null,
      employeeId: e?.employeeId || null,
      name: u.name,
      email: u.email || null,
      phone: u.phoneNumber || null,
      designation: e?.designation || null,
      department: e?.department || null,
      previousNames: [...(u.previousNames || []), ...(e?.previousNames || [])],
      aliases: u.aliases || [],
      status: u.status || null,
      orphan: false,
      hidden: !canUserBeVisible(u, visibilityOverride),
      platformSuperUser: !!u.platformSuperUser,
    };
  });

  // Orphan branch — close the leakage hole. Previously the code assumed any
  // Employee whose owner did NOT appear in the visibility-filtered `users`
  // list was a genuine orphan. That meant a user with status='disabled'
  // (filtered out) would re-enter via this path, contradicting the visible
  // list. Now we re-fetch those owners ignoring status, then DROP rows whose
  // owner is hidden by visibility rules. Genuine orphans (no User row at all)
  // still surface.
  if (includeOrphans) {
    const usersById = new Map(users.map((u) => [String(u._id), u]));
    const missingOwnerIds = employees
      .map((e) => String(e.owner))
      .filter((id) => id && !usersById.has(id));

    let hiddenOwners = new Map();
    if (missingOwnerIds.length) {
      const rows = await UserModel.find(
        { _id: { $in: [...new Set(missingOwnerIds)] } },
        { _id: 1, status: 1, platformSuperUser: 1, name: 1, email: 1, phoneNumber: 1 }
      ).lean();
      hiddenOwners = new Map(rows.map((u) => [String(u._id), u]));
    }

    for (const e of employees) {
      const ownerKey = String(e.owner);
      if (usersById.has(ownerKey)) continue;
      const hiddenUser = hiddenOwners.get(ownerKey);
      if (hiddenUser && !canUserBeVisible(hiddenUser, visibilityOverride)) {
        // User exists but is hidden — DO NOT leak via orphan path.
        // Skip silently; "list" / "count" / direct lookup all agree.
        continue;
      }
      merged.push({
        userId: hiddenUser?._id || null,
        empDocId: e._id,
        employeeId: e.employeeId || null,
        name: hiddenUser?.name || e.fullName,
        email: hiddenUser?.email || null,
        phone: hiddenUser?.phoneNumber || null,
        designation: e.designation || null,
        department: e.department || null,
        previousNames: e.previousNames || [],
        aliases: [],
        status: hiddenUser?.status || null,
        orphan: !hiddenUser,
        hidden: false,
        platformSuperUser: !!hiddenUser?.platformSuperUser,
      });
    }
  }

  for (const m of merged) m.score = scoreMatch(trimmed, m);
  merged.sort((a, b) => b.score - a.score);

  const filtered = merged.filter((m) => m.score >= minScore);
  if (filtered.length === 0) return { kind: 'notFound' };

  const top = filtered[0];
  const second = filtered[1];
  if (filtered.length === 1 || (second && top.score - second.score >= uniqueGap)) {
    return { kind: 'unique', match: top };
  }
  return { kind: 'ambiguous', matches: filtered.slice(0, limit) };
}

/**
 * @typedef {Object} PersonMatch
 * @property {*} userId
 * @property {*} empDocId
 * @property {string|null} employeeId
 * @property {string} name
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} designation
 * @property {string|null} department
 * @property {string[]} previousNames
 * @property {string[]} aliases
 * @property {boolean} orphan
 * @property {number} score
 */
