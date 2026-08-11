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

  const referralLeadQueryContext = readRlContext(deps.memoryDoc ?? null);
  const intent = detectReferralLeadIntent(userMessage, {
    referralLeadQueryContext,
    currentEntitySubject: deps.currentEntitySubject ?? null,
  });
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
        searchLeads,
        saveRlContext,
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
        searchLeads,
        saveRlContext,
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
        searchLeads,
        saveRlContext,
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
  searchLeads,
  saveRlContext,
}) {
  const subject = resolveReferralLeadEntitySubject(userMessage, intent, {
    referralLeadQueryContext,
    currentEntitySubject: null,
  });

  if (!subject?.candidateName) {
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
  });
}

async function finishCandidateLookup({
  lead,
  subject,
  intent,
  userId,
  adminId,
  saveRlContext,
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
  searchLeads,
  saveRlContext,
  deps,
}) {
  const agentName =
    extractSalesAgentNameFromMessage(userMessage, intent) ||
    referralLeadQueryContext?.salesAgentName;

  if (!agentName) {
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
  searchLeads,
  saveRlContext,
  deps,
}) {
  const referrerName =
    extractReferrerNameFromMessage(userMessage, intent) ||
    referralLeadQueryContext?.referrerName;

  if (!referrerName) {
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
