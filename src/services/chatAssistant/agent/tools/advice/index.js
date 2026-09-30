import explainStatus from './explainStatus.tool.js';
import recommend from './recommend.tool.js';
import matchJobsToEmployee from './matchJobsToEmployee.tool.js';

const instructions = [
  'Advice: why-questions, rule-based recommendations and jobs for one employee, built from the other domains\' tools.',
  '- "Why is X unavailable", "why can\'t X join <project>", "why can\'t X move to onboarding", "why isn\'t X in the ' +
    'employee list / org chart", "why can\'t I see X" -> explain_status with the matching question.',
  '- Answer from the rules: name each rule with met false as the reason, say which could not be checked (met ' +
    'null) and why. Never add a rule the result does not list. context rules are not assignment rules.',
  '- "Who should I call / interview first", "who should go on <project>", "who needs training before ' +
    'assignment", "bench for <job>", "what should <team> do first", "where do we need another recruiter", "what ' +
    'should I follow up today" -> recommend with that kind.',
  '- A recommendation is the returned rules applied to evidence: quote the reasons, never add an opinion. ' +
    'recruiter_capacity compares workload, never performance.',
  '- "Which jobs suit X", "internal openings for X", "skill gap for X" -> match_jobs_to_employee.',
  '- Each section has a status. Name restricted sections only, never their data, and never fill one from another tool.',
].join('\n');

export default {
  domain: 'advice',
  summary: 'Why can\'t X join / onboard / show up, who to call or interview first, who to allocate, jobs that suit X',
  instructions,
  tools: [explainStatus, recommend, matchJobsToEmployee],
};
