import countInterviews from './countInterviews.tool.js';
import listInterviews from './listInterviews.tool.js';
import countOffers from './countOffers.tool.js';
import listOffers from './listOffers.tool.js';
import countPlacements from './countPlacements.tool.js';
import listPlacements from './listPlacements.tool.js';
import getHiringFunnel from './getHiringFunnel.tool.js';
import listReferralLeads from './listReferralLeads.tool.js';

const instructions = [
  'Hiring: the ATS pipeline after an application — interviews, offers, placements (pre-boarding, onboarding, ' +
    'joining) and referral leads. These are candidates moving through hiring, not employees.',
  '- Interviews are ATS interviews only. Internal / team meetings are a different thing these tools cannot ' +
    'answer: call handoff for those. "interviewer" is the staff member running it; "candidate" is the person ' +
    'being interviewed — never swap them. "Selected / rejected / pending" is filters.result; "scheduled / ' +
    'ended / cancelled" is filters.status. Periods ("today", "this week") → filters.scheduledBetween as ' +
    'YYYY-MM-DD from today\'s date.',
  '- "How many" questions → count_interviews / count_offers / count_placements; they already return the ' +
    'status (and interview result) breakdown, so do not call again per status.',
  '- "Joined" in a hiring sense — a placement marked Joined, "how many joined this month", "joiners", ' +
    '"who is joining next week" — is count_placements / list_placements with filters.status "Joined" (or the ' +
    'joiningBetween window for upcoming joiners). An employee\'s joining date on the Employees page ("how many ' +
    'employees joined last month") is count_employees joinedBetween instead.',
  '- Pre-boarding → count_placements / list_placements with filters.stage "preBoarding"; onboarding queue → ' +
    'stage "onboarding". Placements leave Cancelled out unless asked; say so when giving a total.',
  '- Offer compensation (CTC) is only returned to people allowed to edit offers. If list_offers says ' +
    'compensationHidden, say you cannot show compensation — never guess it. Never promise offer letter links ' +
    'or rejection reasons.',
  '- "Hiring funnel / tunnel", "referral pipeline", "conversion rate", "top referrer" → get_hiring_funnel. ' +
    'Its numbers are referral leads only — not every candidate, not employees. Pre-boarding runs alongside ' +
    'placements; do not present it as a later step.',
  '- Per-lead referral questions ("who referred X", "X\'s sales agent", "what job was X referred for", "when ' +
    'did X claim the job") → list_referral_leads with filters.candidate. "Which / how many candidates did Y ' +
    'refer" → filters.referrer; "assigned to sales agent Y" → filters.salesAgent. "My referrals / leads I ' +
    'referred" → filters.referrer "me". A pronoun ("her", "him") means the person from the previous turn — ' +
    'pass their real name.',
  '- A result with notFound means that person or record was not found — say so, not "0". A result with ' +
    'matches means the name fits several people: list them and ask which one.',
].join('\n');

// Hiring nouns. "meeting(s)" is deliberately absent: internal meetings are a different, un-migrated domain.
const INTERVIEW_RE = /\b(interviews?|interviewed|interviewers?|interviewing)\b/i;
const OFFER_RE = /\b(offers|offer\s+letters?|job\s+offers?|offer\s+(?:status|code|accepted|sent|pending|rejected|declined)|(?:pending|accepted|rejected|declined|sent|draft)\s+offers?)\b/i;
// "joining" alone is also meetings ("who is joining today's standup") and attendance ("is Rahul joining
// tomorrow"), so it only counts with a period ("joining next week") or as a whole "who is joining today?".
const PLACEMENT_RE = /\b(placements?|pre-?boarding|onboarding\s+(?:queue|stage|status)|background\s+verification|bgv|joiners?|joining\s+date|joining\s+(?:this|next)\s+(?:week|month|quarter))\b/i;
const JOINING_TODAY_RE = /\b(?:who|how\s+many|how\s+many\s+\w+)\s+(?:is|are)\s+joining\s+(?:today|tomorrow)\W*$/i;
// "referred" is misspelled often (reffered, refered) — the legacy router's REFERRED_WORD handled the same slips.
const REFERRAL_RE = /\b(ref{1,2}er{1,2}(?:ed|al|als|rer|rers)|refer\s+leads?|sales\s+agents?|hiring\s+(?:funnel|tunnel|pipeline)|(?:candidate|recruitment)\s+(?:funnel|pipeline)|conversion\s+rate|hires)\b/i;
// "which candidates did Sami refer" — the bare verb only after did/has/have, so "refer to the policy" stays out.
const REFER_VERB_RE = /\b(?:did|has|have)\s+[\w .'-]{1,40}?\s+refer\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return INTERVIEW_RE.test(t) || OFFER_RE.test(t) || PLACEMENT_RE.test(t) || JOINING_TODAY_RE.test(t)
    || REFERRAL_RE.test(t) || REFER_VERB_RE.test(t);
}

export default {
  domain: 'hiring',
  instructions,
  tools: [
    countInterviews, listInterviews, countOffers, listOffers,
    countPlacements, listPlacements, getHiringFunnel, listReferralLeads,
  ],
  matchesTurn,
};
