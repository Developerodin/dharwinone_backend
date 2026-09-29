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

export default {
  domain: 'hiring',
  instructions,
  tools: [
    countInterviews, listInterviews, countOffers, listOffers,
    countPlacements, listPlacements, getHiringFunnel, listReferralLeads,
  ],
};
