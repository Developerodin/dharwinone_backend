import User from '../../../models/user.model.js';
import { resolveRole, loadRoleRegistry } from '../roleRegistry.js';
import { SALES_AGENT_ROLE_NAMES } from '../../../utils/roleHelpers.js';
import { visibleUserStatusClause, canUserBeVisible } from '../visibilityRules.js';
import { usesPronoun } from './activityIntents.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenize = (s) => String(s || '').toLowerCase().split(/[\s,._-]+/).filter(Boolean);

/** Internal Agent ↔ Employee — must NOT match sales-agent / referral-lead queries. */
const AGENT_EMPLOYEE_BLOCK_RE =
  /\b(?:employees?|staff)\b.*\b(?:assigned|under|with)\b.*\b(?:agent|agents?)\b/i;

const REFERRED_BY_RE =
  /\bwho\s+(?:referred|refer(?:red)?)\s+(.+?)\??\s*$/i;

const SALES_AGENT_POSSESSIVE_RE =
  /\b(.+?)['']s\s+sales\s+agent\b/i;

const WHO_SALES_AGENT_RE =
  /\bwho\s+(?:is|'s)\s+(.+?)['']s\s+sales\s+agent\b/i;

const REFERRED_JOB_RE =
  /\bwhat\s+job\s+(?:was|is)\s+(.+?)\s+referred\s+(?:for|to)\b/i;

const CLAIM_JOB_RE =
  /\bwhen\s+did\s+(.+?)\s+claim(?:ed)?\s+(?:the\s+)?job\b/i;

const SALES_AGENT_COUNT_RE =
  /\bhow many\s+candidates?\s+(?:are\s+)?(?:assigned\s+(?:to|for)|under)\s+(.+?)\??\s*$/i;

const SALES_AGENT_LIST_RE =
  /\b(?:which|what|show|list)\s+candidates?\s+(?:are\s+)?(?:assigned\s+(?:to|for)|under)\s+(.+?)\??\s*$/i;

const REFERRER_LIST_RE =
  /\bwhich\s+candidates?\s+did\s+(.+?)\s+refer\b/i;

const REFERRER_COUNT_RE =
  /\bhow many\s+candidates?\s+did\s+(.+?)\s+refer\b/i;

const REFERRAL_SIGNAL_RE =
  /\b(referral(?:\s|-)?leads?|referred\s+by|sales\s+agent|refer(?:red|rer)?)\b/i;

/**
 * @typedef {'referred_by_lookup'|'sales_agent_lookup'|'referred_job_lookup'|'claimed_at_lookup'|'sales_agent_count'|'sales_agent_list'|'referrer_list'|'referrer_count'} ReferralLeadIntent
 */

/**
 * @param {string} message
 * @returns {boolean}
 */
export function looksLikeReferralLeadQuery(message) {
  return Boolean(detectReferralLeadIntent(message));
}

/**
 * @param {string} message
 * @param {{ referralLeadQueryContext?: object|null, currentEntitySubject?: object|null }} [ctx]
 * @returns {ReferralLeadIntent|null}
 */
export function detectReferralLeadIntent(message, ctx = {}) {
  const text = String(message || '').trim();
  if (!text) return null;

  if (AGENT_EMPLOYEE_BLOCK_RE.test(text) && !/\bsales\s+agent\b/i.test(text)) {
    return null;
  }

  if (REFERRED_BY_RE.test(text)) return 'referred_by_lookup';
  if (WHO_SALES_AGENT_RE.test(text) || SALES_AGENT_POSSESSIVE_RE.test(text)) {
    return 'sales_agent_lookup';
  }
  if (REFERRED_JOB_RE.test(text)) return 'referred_job_lookup';
  if (CLAIM_JOB_RE.test(text)) return 'claimed_at_lookup';
  if (SALES_AGENT_COUNT_RE.test(text)) return 'sales_agent_count';
  if (SALES_AGENT_LIST_RE.test(text)) return 'sales_agent_list';
  if (REFERRER_LIST_RE.test(text)) return 'referrer_list';
  if (REFERRER_COUNT_RE.test(text)) return 'referrer_count';

  if (ctx.referralLeadQueryContext?.lastIntent && usesPronoun(text)) {
    return ctx.referralLeadQueryContext.lastIntent;
  }

  if (REFERRAL_SIGNAL_RE.test(text) && ctx.referralLeadQueryContext?.lastIntent) {
    return ctx.referralLeadQueryContext.lastIntent;
  }

  return null;
}

function cleanExtractedName(raw) {
  return String(raw || '')
    .replace(/\?+$/, '')
    .replace(/^(?:the\s+)?(?:a\s+)?job\s+to\s+/i, '')
    .replace(/\b(this|that|the)\b/gi, '')
    .replace(/\b(sales\s+agent|agent)\b/gi, '')
    .trim();
}

/**
 * @param {string} message
 * @param {ReferralLeadIntent|null} intent
 * @returns {string|null}
 */
export function extractCandidateNameFromMessage(message, intent) {
  const text = String(message || '').trim();
  if (!text || usesPronoun(text)) return null;

  const patterns = [];
  if (intent === 'referred_by_lookup' || !intent) {
    patterns.push(REFERRED_BY_RE);
  }
  if (intent === 'sales_agent_lookup' || !intent) {
    patterns.push(WHO_SALES_AGENT_RE, SALES_AGENT_POSSESSIVE_RE);
  }
  if (intent === 'referred_job_lookup' || !intent) {
    patterns.push(REFERRED_JOB_RE);
  }
  if (intent === 'claimed_at_lookup' || !intent) {
    patterns.push(CLAIM_JOB_RE);
  }

  for (const re of patterns) {
    const hit = text.match(re);
    if (!hit?.[1]) continue;
    const name = cleanExtractedName(hit[1]);
    if (name.length >= 2) return name;
  }

  return null;
}

/**
 * @param {string} message
 * @param {ReferralLeadIntent|null} intent
 * @returns {string|null}
 */
export function extractSalesAgentNameFromMessage(message, intent) {
  const text = String(message || '').trim();
  if (!text) return null;

  const patterns = [];
  if (intent === 'sales_agent_count' || intent === 'sales_agent_list' || !intent) {
    patterns.push(SALES_AGENT_COUNT_RE, SALES_AGENT_LIST_RE);
  }

  for (const re of patterns) {
    const hit = text.match(re);
    if (!hit?.[1]) continue;
    const name = cleanExtractedName(hit[1]);
    if (name.length >= 2) return name;
  }

  return null;
}

/**
 * @param {string} message
 * @param {ReferralLeadIntent|null} intent
 * @returns {string|null}
 */
export function extractReferrerNameFromMessage(message, intent) {
  const text = String(message || '').trim();
  if (!text) return null;

  const patterns = [];
  if (intent === 'referrer_list' || intent === 'referrer_count' || !intent) {
    patterns.push(REFERRER_LIST_RE, REFERRER_COUNT_RE);
  }

  for (const re of patterns) {
    const hit = text.match(re);
    if (!hit?.[1]) continue;
    const name = cleanExtractedName(hit[1]);
    if (name.length >= 2) return name;
  }

  return null;
}

function scoreNameMatch(query, doc) {
  const q = String(query || '').trim();
  if (!q) return 0;
  const lcQuery = q.toLowerCase();
  if ((doc.email || '').toLowerCase() === lcQuery) return 1;

  const qTokens = tokenize(q);
  if (!qTokens.length) return 0;

  const haystack = [doc.name, doc.email, ...(doc.previousNames || []), ...(doc.aliases || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const dTokens = tokenize(haystack);

  let exactHits = 0;
  let prefixHits = 0;
  for (const qt of qTokens) {
    if (dTokens.includes(qt)) exactHits += 1;
    else if (dTokens.some((dt) => dt.startsWith(qt))) prefixHits += 1;
  }

  const score = (exactHits * 1.0 + prefixHits * 0.7) / qTokens.length;
  const verbatim = haystack.includes(lcQuery) ? 0.1 : 0;
  return Math.min(1, score + verbatim);
}

async function findUsersByName(name, { roleIds = null, deps = {} } = {}) {
  const UserModel = deps.User ?? User;
  const trimmed = String(name || '').trim();
  if (!trimmed) return [];

  const safe = escapeRegex(trimmed);
  const tokens = tokenize(trimmed).filter((t) => t.length >= 2);
  const tokenOr = tokens.map((t) => ({ name: { $regex: escapeRegex(t), $options: 'i' } }));
  const userOr = [
    { name: { $regex: safe, $options: 'i' } },
    { email: { $regex: safe, $options: 'i' } },
    { previousNames: { $regex: safe, $options: 'i' } },
    { aliases: { $regex: safe, $options: 'i' } },
    ...tokenOr,
  ];

  const filter = {
    status: visibleUserStatusClause(deps.visibility),
    $or: userOr,
  };
  if (roleIds?.length) {
    filter.roleIds = { $in: roleIds };
  }

  const users = await UserModel.find(filter)
    .select('_id name email previousNames aliases hideFromDirectory platformSuperUser status')
    .limit(50)
    .lean();

  const viewer = deps.viewer ?? null;
  const viewerIsSuper = !!viewer?.platformSuperUser;

  return users
    .filter((u) => viewerIsSuper || canUserBeVisible(u, viewer))
    .map((u) => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      score: scoreNameMatch(trimmed, u),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolve a portal User by name (any role — used for referrers).
 * @param {string} name
 * @param {object} [deps]
 */
export async function resolveReferrerUser(name, deps = {}) {
  const matches = await findUsersByName(name, { deps });
  if (!matches.length) return { kind: 'notFound' };
  const best = matches[0];
  if (best.score >= 0.85 || matches.length === 1) {
    return { kind: 'unique', user: best };
  }
  const close = matches.filter((m) => m.score >= best.score - 0.15).slice(0, 5);
  if (close.length === 1) return { kind: 'unique', user: close[0] };
  return { kind: 'ambiguous', matches: close };
}

/**
 * Resolve a Sales Agent role User by name.
 * @param {string} name
 * @param {object} [deps]
 */
export async function resolveSalesAgentUser(name, deps = {}) {
  const loadRegistry = deps.loadRoleRegistry ?? loadRoleRegistry;
  const resolveRoleFn = deps.resolveRole ?? resolveRole;

  const roleIds = [];
  for (const roleName of SALES_AGENT_ROLE_NAMES) {
    const role = await resolveRoleFn(roleName, { loadRoleRegistry: loadRegistry, ...deps });
    roleIds.push(...(role.ids || []).map(String));
  }
  const uniqueRoleIds = [...new Set(roleIds)];
  if (!uniqueRoleIds.length) return { kind: 'notFound' };

  const matches = await findUsersByName(name, { roleIds: uniqueRoleIds, deps });
  if (!matches.length) return { kind: 'notFound' };
  const best = matches[0];
  if (best.score >= 0.85 || matches.length === 1) {
    return { kind: 'unique', user: best };
  }
  const close = matches.filter((m) => m.score >= best.score - 0.15).slice(0, 5);
  if (close.length === 1) return { kind: 'unique', user: close[0] };
  return { kind: 'ambiguous', matches: close };
}

/**
 * @param {string} message
 * @param {ReferralLeadIntent|null} intent
 * @param {{ referralLeadQueryContext?: object|null, currentEntitySubject?: object|null }} ctx
 */
export function resolveReferralLeadEntitySubject(message, intent, ctx = {}) {
  const rlCtx = ctx.referralLeadQueryContext;
  const stored = ctx.currentEntitySubject;

  if (usesPronoun(message) && rlCtx?.candidateName) {
    return {
      candidateName: rlCtx.candidateName,
      candidateId: rlCtx.candidateId ?? null,
      fromContext: true,
    };
  }

  const extracted = extractCandidateNameFromMessage(message, intent);
  if (extracted) {
    return { candidateName: extracted, candidateId: null, fromContext: false };
  }

  if (stored?.name && String(message).toLowerCase().includes(stored.name.toLowerCase())) {
    return { candidateName: stored.name, candidateId: stored.userId ?? null, fromContext: true };
  }

  if (rlCtx?.candidateName) {
    return {
      candidateName: rlCtx.candidateName,
      candidateId: rlCtx.candidateId ?? null,
      fromContext: true,
    };
  }

  return null;
}

export function detectReferralLeadOperation(message, intent) {
  if (intent === 'sales_agent_list' || intent === 'referrer_list') return 'list';
  if (intent === 'sales_agent_count' || intent === 'referrer_count') return 'count';
  if (/\b(list|show|which|what)\b/i.test(String(message || ''))) return 'list';
  return 'lookup';
}
