import getReferral from './getReferral.tool.js';
import getReferralStats from './getReferralStats.tool.js';

const summary = 'Who referred a person, and referral performance per sales agent (applied, offers, joined, conversion).';

const instructions = [
  'Referrals: referral attribution and sales-agent referral performance, from the Refer Leads page.',
  '- "Who referred <person>", "was <person> referred or direct", "which sales agent brought in <person>", ' +
    '"who issued the link" → get_referral. If it returns direct, say no referrer is recorded so they came in ' +
    'directly; if it returns referred null, say they are not among the viewer\'s own leads and do not guess.',
  '- "How is <sales agent> doing", "my referral numbers", conversion, average days to joining, stuck leads, ' +
    'this month vs last → get_referral_stats with salesAgent ("me" for the viewer). "Top / best sales agents", ' +
    '"rank sales agents by joins" → get_referral_stats with rankBy and no salesAgent.',
  '- "How many / which candidates did <person> refer" names the REFERRER, not a sales agent → list_referral_leads ' +
    'with filters.referrer (hiring domain — load it with find_tools). get_referral_stats is only for a sales ' +
    'agent\'s performance. Listing referral leads with filters stays on list_referral_leads; the referral funnel ' +
    'stays on get_hiring_funnel.',
  '- Days in stage come from get_referral_stats stuck.byStage; a stage with leadsWithStageDate below its count ' +
    'has leads with no recorded entry date — say the days cover only those with one.',
  '- WhatsApp shares and link opens are not captured in DharwinOne — say so instead of estimating.',
].join('\n');

export default {
  domain: 'referrals',
  summary,
  instructions,
  tools: [getReferral, getReferralStats],
};
