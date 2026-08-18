import {
  detectReferralLeadIntent,
  detectReferralLeadOperation,
  extractReferrerNameFromMessage,
  extractSalesAgentNameFromMessage,
  resolveReferralLeadEntitySubject,
  resolveReferrerUser,
  resolveSalesAgentUser,
} from './referralLeadIntents.js';
import {
  readReferralLeadQueryContext,
  saveReferralLeadQueryContext,
} from '../conversationState/referralLeadQueryContext.js';
import {
  renderClaimedAtReply,
  renderReferralLeadDisambiguation,
  renderReferredByReply,
  renderReferredJobReply,
  renderReferrerListReply,
  renderSalesAgentCountReply,
  renderSalesAgentReply,
} from '../conversationPolicy/renderReferralLead.js';
import {
  hasReferralLeadsReadAccess,
  searchReferralLeads,
} from '../referralLeadsAnalytics.js';
import { writeEntitySubject } from '../conversationState/entitySubject.js';
import { usesPronoun } from './activityIntents.js';

/** Same TTL as the other pending flows (pendingEntity.js, pendingJob.js). */
const AWAITING_TTL_MS = 10 * 60 * 1000;

/** Words that mark a message as a new question, not a name answer. */
const QUESTION_SHAPE_RE =
  /\b(who|whom|whose|what|when|where|which|why|how|is|are|was|were|do|does|did|can|could|should|would|list|show|count|many|please|yes|no|ok|okay|nope|yeah|cancel|nevermind)\b/i;

/**
 * A reply to "Which referral-lead candidate should I look up?" is a short
 * name-shaped fragment. Anything question-shaped, pronoun-bearing, or long
 * falls through to the other routers untouched.
 * @param {string} message
 * @returns {string|null} the cleaned name, or null
 */
function bareNameAnswer(message) {
  const text = String(message || '').trim().replace(/[?.!]+$/, '').trim();
  if (!text || text.length < 2 || text.length > 60) return null;
  if (usesPronoun(text) || QUESTION_SHAPE_RE.test(text)) return null;
  const tokens = text.split(/\s+/);
  if (tokens.length > 5) return null;
  return text;
}

/**
 * Pre-LLM gate for referral-lead domain queries (separate from Agent↔Employee and Applications).
 *
 * @param {{
 *   userMessage: string,
 *   user: object,
 *   adminId: any,
 *   userId: any,
 *   deps?: object,
 * }} opts
 * @returns {Promise<{ reply: string, blocks: object[], meta: object }|null>}
 */
export async function handleReferralLeadQuery({
  userMessage,
  user,
  adminId,
  userId,
  deps = {},
}) {
  const readRlContext = deps.readReferralLeadQueryContext ?? readReferralLeadQueryContext;
  const saveRlContext = deps.saveReferralLeadQueryContext ?? saveReferralLeadQueryContext;
  const searchLeads = deps.searchReferralLeads ?? searchReferralLeads;
  const writeSubject = deps.writeEntitySubject ?? writeEntitySubject;

  const referralLeadQueryContext = readRlContext(deps.memoryDoc ?? null);
  let intent = detectReferralLeadIntent(userMessage, {
    referralLeadQueryContext,
    currentEntitySubject: deps.currentEntitySubject ?? null,
  });

  // The answer to our own clarifying question. A bare name carries no referral
  // vocabulary, so the detector can't claim it — the fresh `awaiting` marker
  // written by the clarify branch is what routes it back here instead of
  // letting it fall through to the LLM path ("No employee found…").
  let pendingNameAnswer = null;
  if (!intent && referralLeadQueryContext?.awaiting) {
    const askedAt = referralLeadQueryContext.awaitingAt
      ? new Date(referralLeadQueryContext.awaitingAt).getTime()
      : 0;
    const fresh = askedAt && Date.now() - askedAt <= AWAITING_TTL_MS;
    const name = fresh ? bareNameAnswer(userMessage) : null;
    if (name) {
      intent = referralLeadQueryContext.awaiting;
      pendingNameAnswer = name;
    }
  }
  if (!intent) return null;

  const permissions = user?.authContext?.permissions;
  if (user?.platformSuperUser !== true && !hasReferralLeadsReadAccess(permissions)) {
    return {
      reply: "You don't have access to referral leads data.",
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true, forbidden: true },
    };
  }

  const operation = detectReferralLeadOperation(userMessage, intent);

  switch (intent) {
    case 'referred_by_lookup':
    case 'sales_agent_lookup':
    case 'referred_job_lookup':
    case 'claimed_at_lookup':
      return handleCandidateLookup({
        userMessage,
        user,
        adminId,
        userId,
        intent,
        referralLeadQueryContext,
        currentEntitySubject: deps.currentEntitySubject ?? null,
        pendingNameAnswer,
        searchLeads,
        saveRlContext,
        writeSubject,
      });
    case 'sales_agent_count':
    case 'sales_agent_list':
      return handleSalesAgentScope({
        userMessage,
        user,
        adminId,
        userId,
        intent,
        operation,
        referralLeadQueryContext,
        pendingNameAnswer,
        searchLeads,
        saveRlContext,
        writeSubject,
        deps,
      });
    case 'referrer_list':
    case 'referrer_count':
      return handleReferrerScope({
        userMessage,
        user,
        adminId,
        userId,
        intent,
        operation,
        referralLeadQueryContext,
        pendingNameAnswer,
        searchLeads,
        saveRlContext,
        writeSubject,
        deps,
      });
    default:
      return null;
  }
}

async function handleCandidateLookup({
  userMessage,
  user,
  adminId,
  userId,
  intent,
  referralLeadQueryContext,
  currentEntitySubject = null,
  pendingNameAnswer = null,
  searchLeads,
  saveRlContext,
  writeSubject,
}) {
  // currentEntitySubject carries the person resolved by an earlier turn in another
  // domain. Hardcoding null here meant "Who referred her?" could never bind to the
  // person the user had just asked about, and the handler asked which candidate to
  // look up instead of answering.
  // pendingNameAnswer is the user's reply to our own clarifying question — the
  // whole message IS the name, so it outranks pattern extraction.
  const subject = pendingNameAnswer
    ? { candidateName: pendingNameAnswer, candidateId: null, fromPendingQuestion: true }
    : resolveReferralLeadEntitySubject(userMessage, intent, {
      referralLeadQueryContext,
      currentEntitySubject,
    });

  if (!subject?.candidateName) {
    // Remember what we asked, or the name-only reply to this question has no
    // referral vocabulary to route it back here and dies in the LLM path.
    // Same pattern as pendingEntity.js / pendingJob.js: state first, then ask.
    if (userId && adminId) {
      await saveRlContext({
        userId,
        adminId,
        queryContext: {
          ...(referralLeadQueryContext || {}),
          awaiting: intent,
          awaitingAt: new Date(),
        },
      });
    }
    return {
      reply: 'Which referral-lead candidate should I look up?',
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true },
    };
  }

  const result = await searchLeads(user, { search: subject.candidateName, limit: 10, page: 1 });
  if (result?.forbidden) {
    return {
      reply: "You don't have access to referral leads data.",
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true, forbidden: true },
    };
  }

  const rows = result?.results ?? [];
  if (!rows.length) {
    // Persist the miss with the name as anchor — this also clears any
    // `awaiting` marker so the NEXT message isn't consumed as another answer.
    if (userId && adminId) {
      await saveRlContext({
        userId,
        adminId,
        queryContext: { candidateName: subject.candidateName, lastIntent: intent, lastTotal: 0 },
      });
    }
    const reply = renderLookup(intent, { lead: null, candidateName: subject.candidateName });
    return wrapReply(reply, intent, { candidateName: subject.candidateName, total: 0 });
  }

  if (rows.length > 1) {
    const exact = rows.filter(
      (r) => r.fullName?.toLowerCase() === subject.candidateName.toLowerCase()
    );
    if (exact.length === 1) {
      return finishCandidateLookup({
        lead: exact[0],
        subject,
        intent,
        userId,
        adminId,
        saveRlContext,
        writeSubject,
      });
    }
    return {
      reply: renderReferralLeadDisambiguation({ query: subject.candidateName, matches: rows }),
      blocks: [],
      meta: {
        kind: 'referral_lead_query',
        intent,
        ambiguous: true,
        deterministic: true,
      },
    };
  }

  return finishCandidateLookup({
    lead: rows[0],
    subject,
    intent,
    userId,
    adminId,
    saveRlContext,
    writeSubject,
  });
}

async function finishCandidateLookup({
  lead,
  subject,
  intent,
  userId,
  adminId,
  saveRlContext,
  writeSubject,
}) {
  const candidateName = lead?.fullName || subject.candidateName;
  const reply = renderLookup(intent, { lead, candidateName });

  if (userId && adminId) {
    await saveRlContext({
      userId,
      adminId,
      queryContext: {
        candidateName,
        candidateId: lead?.id ?? null,
        lastIntent: intent,
        lastTotal: 1,
      },
    });
    // Promote the resolved person to the cross-domain subject so the next
    // follow-up in ANY domain ("what's her email?") still means this person.
    // referralLeadQueryContext above is referral-domain-local; without this
    // write the lookup answered and the conversation forgot who "her" was.
    // lead.id is the candidates-collection doc id → empDocId (never userId,
    // which is a User ref).
    if (typeof writeSubject === 'function' && candidateName) {
      await writeSubject({
        userId,
        adminId,
        subject: {
          entityType: 'employee',
          name: candidateName,
          empDocId: lead?.id ?? null,
        },
      });
    }
  }

  return wrapReply(reply, intent, {
    candidateName,
    candidateId: lead?.id ?? null,
    total: 1,
    relationship: relationshipForIntent(intent),
  });
}

function renderLookup(intent, input) {
  switch (intent) {
    case 'referred_by_lookup':
      return renderReferredByReply(input);
    case 'sales_agent_lookup':
      return renderSalesAgentReply(input);
    case 'referred_job_lookup':
      return renderReferredJobReply(input);
    case 'claimed_at_lookup':
      return renderClaimedAtReply(input);
    default:
      return renderReferredByReply(input);
  }
}

function relationshipForIntent(intent) {
  switch (intent) {
    case 'referred_by_lookup':
      return 'REFERRED_BY';
    case 'sales_agent_lookup':
      return 'ASSIGNED_SALES_AGENT';
    case 'referred_job_lookup':
      return 'REFERRED_JOB';
    case 'claimed_at_lookup':
      return 'CLAIMED_AT';
    default:
      return null;
  }
}

async function handleSalesAgentScope({
  userMessage,
  user,
  adminId,
  userId,
  intent,
  operation,
  referralLeadQueryContext,
  pendingNameAnswer = null,
  searchLeads,
  saveRlContext,
  writeSubject,
  deps,
}) {
  const agentName =
    extractSalesAgentNameFromMessage(userMessage, intent) ||
    pendingNameAnswer ||
    referralLeadQueryContext?.salesAgentName;

  if (!agentName) {
    // State first, then ask — see handleCandidateLookup.
    if (userId && adminId) {
      await saveRlContext({
        userId,
        adminId,
        queryContext: {
          ...(referralLeadQueryContext || {}),
          awaiting: intent,
          awaitingAt: new Date(),
        },
      });
    }
    return {
      reply: 'Which sales agent should I count candidates for?',
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true },
    };
  }

  const resolved = await resolveSalesAgentUser(agentName, { viewer: user, ...deps });
  if (resolved.kind === 'ambiguous') {
    const listed = resolved.matches
      .map((m, i) => `${i + 1}. **${m.name}**${m.email ? ` (${m.email})` : ''}`)
      .join('\n');
    return {
      reply: `I found several sales agents matching **${agentName}**. Which one?\n\n${listed}`,
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, ambiguous: true, deterministic: true },
    };
  }
  if (resolved.kind !== 'unique') {
    return {
      reply: `I couldn't find a sales agent named **${agentName}**.`,
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true },
    };
  }

  const result = await searchLeads(user, {
    salesAgentUserId: resolved.user.id,
    limit: operation === 'list' ? 25 : 1,
    page: 1,
  });

  const total = Number(result?.total ?? 0);
  const reply = renderSalesAgentCountReply({
    salesAgentName: resolved.user.name,
    total,
    operation: operation === 'list' ? 'list' : 'count',
    leads: result?.results ?? [],
  });

  if (userId && adminId) {
    await saveRlContext({
      userId,
      adminId,
      queryContext: {
        salesAgentName: resolved.user.name,
        salesAgentUserId: resolved.user.id,
        lastIntent: intent,
        lastTotal: total,
      },
    });
    // The resolved sales agent is a real User — promote them to the shared
    // subject so "what's their email?" works outside the referral domain too.
    if (typeof writeSubject === 'function') {
      await writeSubject({
        userId,
        adminId,
        subject: {
          entityType: 'employee',
          userId: resolved.user.id,
          entityId: resolved.user.id,
          name: resolved.user.name,
        },
      });
    }
  }

  return wrapReply(reply, intent, {
    salesAgentName: resolved.user.name,
    salesAgentUserId: resolved.user.id,
    total,
    operation,
    relationship: 'SALES_AGENT_CANDIDATES',
  });
}

async function handleReferrerScope({
  userMessage,
  user,
  adminId,
  userId,
  intent,
  operation,
  referralLeadQueryContext,
  pendingNameAnswer = null,
  searchLeads,
  saveRlContext,
  writeSubject,
  deps,
}) {
  const referrerName =
    extractReferrerNameFromMessage(userMessage, intent) ||
    pendingNameAnswer ||
    referralLeadQueryContext?.referrerName;

  if (!referrerName) {
    // State first, then ask — see handleCandidateLookup.
    if (userId && adminId) {
      await saveRlContext({
        userId,
        adminId,
        queryContext: {
          ...(referralLeadQueryContext || {}),
          awaiting: intent,
          awaitingAt: new Date(),
        },
      });
    }
    return {
      reply: 'Which referrer should I list candidates for?',
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true },
    };
  }

  const resolved = await resolveReferrerUser(referrerName, { viewer: user, ...deps });
  if (resolved.kind === 'ambiguous') {
    const listed = resolved.matches
      .map((m, i) => `${i + 1}. **${m.name}**${m.email ? ` (${m.email})` : ''}`)
      .join('\n');
    return {
      reply: `I found several people matching **${referrerName}**. Which referrer did you mean?\n\n${listed}`,
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, ambiguous: true, deterministic: true },
    };
  }
  if (resolved.kind !== 'unique') {
    return {
      reply: `I couldn't find a user named **${referrerName}**.`,
      blocks: [],
      meta: { kind: 'referral_lead_query', intent, deterministic: true },
    };
  }

  const result = await searchLeads(user, {
    referredByUserId: resolved.user.id,
    limit: operation === 'count' ? 1 : 25,
    page: 1,
  });

  const total = Number(result?.total ?? 0);
  const reply = renderReferrerListReply({
    referrerName: resolved.user.name,
    total,
    operation: operation === 'count' ? 'count' : 'list',
    leads: result?.results ?? [],
  });

  if (userId && adminId) {
    await saveRlContext({
      userId,
      adminId,
      queryContext: {
        referrerName: resolved.user.name,
        referrerUserId: resolved.user.id,
        lastIntent: intent,
        lastTotal: total,
      },
    });
    // Same promotion as the sales-agent scope — the referrer is a resolved User.
    if (typeof writeSubject === 'function') {
      await writeSubject({
        userId,
        adminId,
        subject: {
          entityType: 'employee',
          userId: resolved.user.id,
          entityId: resolved.user.id,
          name: resolved.user.name,
        },
      });
    }
  }

  return wrapReply(reply, intent, {
    referrerName: resolved.user.name,
    referrerUserId: resolved.user.id,
    total,
    operation,
    relationship: 'REFERRER_CANDIDATES',
  });
}

function wrapReply(reply, intent, extra = {}) {
  return {
    reply,
    blocks: [],
    meta: {
      kind: 'referral_lead_query',
      intent,
      population: 'referral_lead',
      deterministic: true,
      ...extra,
    },
  };
}
