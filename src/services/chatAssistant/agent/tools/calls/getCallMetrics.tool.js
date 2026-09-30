import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { CALLS_ACCESS, metricFilters, callsScope, callsDeps, runCallMetrics } from './common.js';

export default defineTool({
  name: 'get_call_metrics',
  domain: 'calls',
  kind: 'read',
  description:
    'Call performance for a window (calledBetween) and optional person / caller / call type: total calls, ' +
    'per-status counts, answer rate, average talk time of answered calls, failed count and — with the Call AI ' +
    'toggle — the interest-confirmed rate; plus applicant follow-ups: applicants not yet called, callbacks due ' +
    'and callbacks overdue. Use for "what was our answer rate this week", "average call duration in September", ' +
    '"how many AI calls confirmed interest", "how many applicants haven\'t been called". For WHO needs a callback ' +
    'or was never called use list_call_followups.',
  measure:
    'Call RECORDS you can see on the Call Records page in the window (raw records, like the page total). ' +
      'answerRate = completed calls ÷ finished calls (completed, failed, no answer, busy, declined, disconnected, ' +
      'expired); avgDurationSeconds = mean duration of completed calls with a duration; interestConfirmed.rate = ' +
      '"still interested" answers ÷ calls where the AI captured an interest answer. Applicant follow-ups are ' +
      'open job APPLICATIONS on the Applications page (not Offered / Hired / Rejected / withdrawn) and ignore the ' +
      'person / caller / call-type filters: notYetCalledApplicants = applied in the window with no call record; ' +
      'callbacksDue / callbacksOverdue = callback requests pending now (not windowed).',
  input: Joi.object({ filters: metricFilters }),
  access: CALLS_ACCESS,
  async execute({ filters } = {}, ctx) {
    const user = callsScope(ctx);
    return runCallMetrics({ filters: filters || {}, user, deps: callsDeps(ctx) });
  },
  // No count facts: the reply quotes several call counts (answered, failed, per status) and
  // enforceCounts would rewrite every "N calls" to the one total.
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [] };
  },
});
