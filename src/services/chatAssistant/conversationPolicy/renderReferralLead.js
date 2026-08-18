import { linkTypeLabel } from '../referralLeadFieldMap.js';

const DISPLAY_TZ = 'Asia/Kolkata';

function formatDateIST(value) {
  if (!value && value !== 0) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function formatDateTimeIST(value) {
  if (!value && value !== 0) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const date = d.toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });
    const time = d.toLocaleTimeString('en-GB', {
      timeZone: DISPLAY_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `${date} ${time} IST`;
  } catch {
    return d.toISOString();
  }
}

function personLabel(person) {
  if (!person) return null;
  return person.name || person.email || 'Unknown';
}

/**
 * @param {{ lead: object|null, candidateName: string }} input
 */
export function renderReferredByReply({ lead, candidateName }) {
  const label = candidateName || lead?.fullName || 'this candidate';
  if (!lead) {
    return `I couldn't find a referral lead matching **${label}**.`;
  }
  const referrer = lead.referredBy;
  if (!referrer) {
    return `**${label}** is a referral lead, but no referrer is recorded.`;
  }
  const who = personLabel(referrer);
  return `**${who}** referred **${label}**.`;
}

/**
 * @param {{ lead: object|null, candidateName: string }} input
 */
export function renderSalesAgentReply({ lead, candidateName }) {
  const label = candidateName || lead?.fullName || 'this candidate';
  if (!lead) {
    return `I couldn't find a referral lead matching **${label}**.`;
  }
  const agent = lead.salesAgent;
  if (!agent) {
    return `**${label}** has no sales agent assigned yet.`;
  }
  return `**${personLabel(agent)}** is the sales agent for **${label}**.`;
}

/**
 * @param {{ lead: object|null, candidateName: string }} input
 */
export function renderReferredJobReply({ lead, candidateName }) {
  const label = candidateName || lead?.fullName || 'this candidate';
  if (!lead) {
    return `I couldn't find a referral lead matching **${label}**.`;
  }
  if (lead.referralContext === 'SHARE_CANDIDATE_ONBOARD') {
    return `**${label}** came through an **onboard invite** link — there is no job association.`;
  }
  const job = lead.job;
  if (!job?.title) {
    return `**${label}** is a referral lead, but no job is linked on the referral record.`;
  }
  return `**${label}** was referred for **${job.title}**.`;
}

/**
 * @param {{ lead: object|null, candidateName: string }} input
 */
export function renderClaimedAtReply({ lead, candidateName }) {
  const label = candidateName || lead?.fullName || 'this candidate';
  if (!lead) {
    return `I couldn't find a referral lead matching **${label}**.`;
  }
  if (lead.referralContext === 'SHARE_CANDIDATE_ONBOARD') {
    return `**${label}** used an **onboard invite** link — there is no job claim timestamp.`;
  }
  const at = lead.referredAt;
  if (!at) {
    return `**${label}** is a referral lead, but no claim date is recorded.`;
  }
  return `**${label}** claimed the job on **${formatDateTimeIST(at)}**.`;
}

/**
 * @param {{ salesAgentName: string, total: number, operation?: 'count'|'list', leads?: object[] }} input
 */
export function renderSalesAgentCountReply({
  salesAgentName,
  total,
  operation = 'count',
  leads = [],
}) {
  const agent = salesAgentName || 'that sales agent';
  if (operation === 'list') {
    if (total <= 0) {
      return `**${agent}** has no referral-lead candidates assigned.`;
    }
    const names = leads.map((l) => l.fullName).filter(Boolean);
    if (names.length === 1) {
      return `**${agent}** has 1 assigned candidate: **${names[0]}**.`;
    }
    const listed = names.slice(0, 20).map((n) => `**${n}**`).join(', ');
    const tail = total > 20 ? ` (and ${total - 20} more)` : '';
    return `**${agent}** has **${total}** assigned candidates: ${listed}${tail}.`;
  }
  if (total <= 0) {
    return `**${agent}** has **0** referral-lead candidates assigned.`;
  }
  const noun = total === 1 ? 'candidate' : 'candidates';
  return `**${total}** referral-lead ${noun} ${total === 1 ? 'is' : 'are'} assigned to **${agent}**.`;
}

/**
 * @param {{ referrerName: string, total: number, operation?: 'count'|'list', leads?: object[] }} input
 */
export function renderReferrerListReply({
  referrerName,
  total,
  operation = 'list',
  leads = [],
}) {
  const who = referrerName || 'that person';
  if (total <= 0) {
    return `**${who}** has not referred any candidates on the referral-leads list.`;
  }
  if (operation === 'count') {
    const noun = total === 1 ? 'candidate' : 'candidates';
    return `**${who}** referred **${total}** ${noun}.`;
  }
  const names = leads.map((l) => l.fullName).filter(Boolean);
  if (names.length === 1) {
    return `**${who}** referred **${names[0]}**.`;
  }
  const listed = names.slice(0, 20).map((n) => `**${n}**`).join(', ');
  const tail = total > 20 ? ` (and ${total - 20} more)` : '';
  return `**${who}** referred **${total}** candidates: ${listed}${tail}.`;
}

/**
 * @param {object[]} matches
 */
export function renderReferralLeadDisambiguation({ query, matches = [] }) {
  const lines = matches.slice(0, 5).map((m, i) => {
    const link = linkTypeLabel(m.referralContext);
    const extra = link ? ` · ${link}` : '';
    return `${i + 1}. **${m.fullName}**${m.email ? ` (${m.email})` : ''}${extra}`;
  });
  return `I found several referral leads matching **${query}**. Which one did you mean?\n\n${lines.join('\n')}`;
}
