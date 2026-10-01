import runCrossCheck from './runCrossCheck.tool.js';
import getRecruitmentFunnel from './getRecruitmentFunnel.tool.js';

const instructions = [
  'Cross-module checks and the recruitment funnel.',
  '- A question that combines two modules — "who joins next week but pre-boarding isn\'t done" ' +
    '(joining_next_week_preboarding_incomplete), "trained but on no project", "absent today with tasks due", ' +
    '"on leave tomorrow with an interview", "passed interview but no offer", "BGV done but not onboarding", ' +
    '"bench people who fit the latest jobs", "applications untouched for 5 days" → run_cross_check with the ' +
    'matching query. One module only → that module\'s tool. "Accepted offers with no pre-boarding started" and ' +
    '"joining date already passed but not onboarded" are hiring filters, not crosscheck.',
  '- Conversion rates, where candidates drop off, the slowest stage, time to hire / onboard, recruiter ' +
    'workload, this month vs last month → get_recruitment_funnel (compareTo "previous" for the comparison).',
  '- Report total; when atLeast is true say "at least N". Say the definition in plain words.',
  '- A restricted check or section: name what the user lacks access to, never guess its data.',
  '- Funnel: give each rate with its numerator and denominator, and say the basis (how many applications ' +
    'used status history vs interview / offer dates). Screening is only measured on history-basis rows.',
  '- applications_unchanged: say whether the dates came from the status-change time or the last edit (basis).',
  '- Recruiter workload is pending work only — never describe it as recruiter performance or quality.',
].join('\n');

export default {
  domain: 'crosscheck',
  summary: 'Cross-module X-but-not-Y lists (on leave with a meeting, trained no project) and hiring funnel: conversions, slow stages',
  instructions,
  tools: [runCrossCheck, getRecruitmentFunnel],
};
