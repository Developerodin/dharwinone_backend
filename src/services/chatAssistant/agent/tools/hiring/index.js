import countInterviews from './countInterviews.tool.js';
import listInterviews from './listInterviews.tool.js';
import getInterview from './getInterview.tool.js';
import getInterviewerAvailability from './getInterviewerAvailability.tool.js';
import listAwaitingAvailability from './listAwaitingAvailability.tool.js';
import getInterviewTranscript from './getInterviewTranscript.tool.js';
import countOffers from './countOffers.tool.js';
import listOffers from './listOffers.tool.js';
import getOffer from './getOffer.tool.js';
import countPlacements from './countPlacements.tool.js';
import listPlacements from './listPlacements.tool.js';
import getPlacement from './getPlacement.tool.js';
import listDocuments from './listDocuments.tool.js';
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
  '- One interview in detail ("how did <candidate>\'s interview go", panel, who scheduled it, who joined, ' +
    'recorded?, AI summary, evaluations, who changed the result and when) → get_interview with candidate ' +
    '(+ jobPosition) or id. { matches } → list them and ask, or call again with the id. AI summaries and ' +
    'evaluations are opinions from AI or staff — attribute them. aiSummaryHidden = the user may not see ' +
    'summaries; historyHidden = they cannot see activity logs.',
  '- "What did <candidate> say", "transcript" → get_interview_transcript; includeFullText only when the full ' +
    'transcript is asked for. Quote it as what the speaker said, never as fact.',
  '- "Ended but no result", "waiting for a result" → filters.resultMissing (list_interviews for "which / show", ' +
    'count_interviews only for "how many"). "Passed" = result selected, "failed" = ' +
    'rejected; there is no "hold" result. Panel clashes / double-booked interviewers → filters.overlapping with ' +
    'scheduledBetween; it only compares interviews the user can see. Cancelled interviews → filters.status ' +
    '"cancelled".',
  '- Interviewer free time ("when is <interviewer> free", "common free time") → get_interviewer_availability. ' +
    'Open slots (hours minus interviews, meetings and holds) need interviews.manage; otherwise these are the ' +
    'stored weekly hours only. Common free time needs at least two interviewers. availabilitySet false means ' +
    'no hours are stored — never guess a slot.',
  '- "Who hasn\'t chosen a time", "booking link sent but no slot" → list_awaiting_availability. A hold that ' +
    'is held, approving or approved means they picked a time. Rejected, expired or cancelled holds are not a pick.',
  '- When a reminder will send, and whether it already went → get_interview reminderAt, reminderSent and ' +
    'reminderSentAt. reminderAt null means no reminder time is stored — never invent one.',
  '- Not captured in DharwinOne: RSVP (get_interview attendance only says who joined the video room), ' +
    'invitation email delivery, reschedule history. Who set a result and when is get_interview history. Say ' +
    'so — never guess.',
  '- "How many" questions → count_interviews / count_offers / count_placements; they already return the ' +
    'status (and interview result) breakdown, so do not call again per status.',
  '- "Joined" in a hiring sense — a placement marked Joined, "how many joined this month", "joiners", ' +
    '"who is joining next week" — is count_placements / list_placements with filters.status "Joined" (or the ' +
    'joiningBetween window for upcoming joiners). An employee\'s joining date on the Employees page ("how many ' +
    'employees joined last month") is count_employees joinedBetween instead.',
  '- Pre-boarding → count_placements / list_placements with filters.stage "preBoarding"; onboarding queue → ' +
    'stage "onboarding". Placements leave Cancelled out unless asked; say so when giving a total.',
  '- Offer compensation (CTC) is only returned to people allowed to edit offers. If a result says ' +
    'compensationHidden, say you cannot show compensation — never guess it. Never promise rejection reasons; ' +
    'get_offer\'s letter.pdfUrl is the only letter link, only for viewers who can see compensation, and is ' +
    'usually null.',
  '- One offer in full (who prepared it, who sent it and when, days pending, letter, salary if allowed) → get_offer ' +
    'with the candidate name (or offerCode) directly — no list_offers call first. ' +
    '"Offers pending more than N days" → filters.pendingOverDays = N; "accepted but pre-boarding not started" → ' +
    'filters.acceptedNoPreboarding. There is no SLA: if the user gives no day count, ask for one. get_offer ' +
    'markedSentBy / markedSentAt = who marked it Sent in DharwinOne and when (DharwinOne then emails the ' +
    'candidate an automatic notice); the letter itself goes out via Outlook and its delivery is not captured — ' +
    'say so. markedSentByNote means not on record — never guess. sentDateMissing = still-pending offers with ' +
    'no sent date; they are not in a pendingOverDays answer — mention them.',
  '- One person\'s placement steps, what is blocking them, their agent / department, or whether they are an ' +
    'employee yet → get_placement. "BGV pending" → filters.bgvPending; "ready for BGV" → filters.readyForBgv; ' +
    '"joining date passed but not onboarded" → filters.joinDatePassedNotOnboarded. "Who changed X\'s placement ' +
    'status" → get_placement auditTrail (placement audit access only; no auditTrail key = not allowed, never ' +
    'say "no changes"). "In onboarding who haven\'t joined" → filters.onboardingNotJoined (status Onboarding, ' +
    'joining date today or later — not Cancelled, Deferred, Joined, or people who already joined). ' +
    'notJoinedReason date_ahead: still Onboarding or pre-boarding Pending and the joining date is ahead, so ' +
    'not joined yet. cancelled or deferred: not joined; someone set that status — name queue (onboarding or ' +
    'preBoarding). Date passed, hasUserAccount, status still Onboarding or Pending: joined is true even though ' +
    'status was not moved to Joined; role does not matter. notJoinedReason no_account: the date passed and ' +
    'there is no user account, so not joined. Status Joined is joined.',
  '- Documents (uploaded, missing, pending review, approved, rejected and why, EAD / visa expiring) → ' +
    'list_documents: person for one person, cohort (placement filters) for a group, neither for "my documents". ' +
    '"Missing" means requested by staff and not uploaded yet. list_documents cohort: if scanTruncated, say the ' +
    'answer covers only the rows scanned.',
  '- "Hiring funnel / tunnel", "referral pipeline", "conversion rate", "top referrer" → get_hiring_funnel. ' +
    'Its numbers are referral leads only — not every candidate, not employees. Pre-boarding runs alongside ' +
    'placements; do not present it as a later step.',
  '- Per-lead referral questions ("who referred X", "X\'s sales agent", "what job was X referred for", "when ' +
    'did X claim the job") → list_referral_leads with filters.candidate. "Which / how many candidates did Y ' +
    'refer" → filters.referrer; "assigned to sales agent Y" → filters.salesAgent. "My referrals / leads I ' +
    'referred" → filters.referrer "me". A pronoun ("her", "him") means the person from the previous turn — ' +
    'pass their real name.',
  '- Move to Offer: if offerReady is true, the application can move to the offer letter page because a non-cancelled round is Selected; if false, it cannot, and say why from offerReadyReason. Other rounds do not all have to be Selected. When offerReady is present, do not guess from a single row\'s result.',
  '- A result with notFound means that person or record was not found — say so, not "0". A result with ' +
    'matches means the name fits several people: list them and ask which one.',
].join('\n');

export default {
  domain: 'hiring',
  summary: 'Hiring after applying: interviews, offers, placements/onboarding/BGV, candidate documents, funnel, referral leads.',
  instructions,
  tools: [
    countInterviews, listInterviews, getInterview, getInterviewerAvailability, listAwaitingAvailability,
    getInterviewTranscript, countOffers, listOffers, getOffer,
    countPlacements, listPlacements, getPlacement, listDocuments, getHiringFunnel, listReferralLeads,
  ],
};
