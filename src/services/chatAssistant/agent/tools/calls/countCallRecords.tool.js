import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { CALLS_ACCESS, callFilters, callsScope, callsDeps, runCallCount, callCountFacts } from './common.js';

const GROUP_LABELS = { status: 'Status', day: 'Day', caller: 'Placed by', hangupBy: 'Hung up by' };

export default defineTool({
  name: 'count_call_records',
  domain: 'calls',
  kind: 'read',
  description:
    'Count phone call records (Communication → Call Records: AI agent verification calls and dialer calls), ' +
    'optionally grouped by status, day, the user who placed them or who hung up. Use for "how many calls did ' +
    'we make this week", "how many calls to Priya", "calls per day in September", "who made the most calls", ' +
    '"how many AI calls did the candidate hang up on". ' +
    'Not for answer rates or averages (get_call_metrics), not for interviews or internal meetings.',
  measure:
    'Call RECORDS you can see on the Call Records page (every call for Administrators, otherwise calls you ' +
      'placed or on jobs / candidates you own); every status unless filters say otherwise. Raw records, like the ' +
      'page total: a Twilio dialer call can be stored as two legs and counts twice.',
  input: Joi.object({
    filters: callFilters,
    groupBy: Joi.string().valid('status', 'day', 'caller', 'hangupBy')
      .description('Break the count down by call status, IST day, the user who placed the call, or who hung up ' +
        '(hangupBy: reported on AI agent calls only; others are "Not recorded").'),
  }),
  access: CALLS_ACCESS,
  async execute({ filters, groupBy } = {}, ctx) {
    const user = callsScope(ctx);
    return runCallCount({ filters: filters || {}, groupBy, user, deps: callsDeps(ctx) });
  },
  render(result) {
    if (!result || result.error) return null;
    if (!result.groupBy) return { blocks: [], facts: callCountFacts('count_call_records', result.total) };
    const label = GROUP_LABELS[result.groupBy];
    const rows = result.groups.map((g) => ({ value: String(g.value), count: String(g.count) }));
    if (result.otherCount) rows.push({ value: 'Other', count: String(result.otherCount) });
    return {
      blocks: [{
        type: 'table',
        id: 'call-breakdown',
        tableType: 'call-breakdown',
        title: `Calls by ${label.toLowerCase()} (${result.total})`,
        columns: [
          { key: 'value', label, priority: 'primary' },
          { key: 'count', label: 'Calls', priority: 'primary', format: 'number' },
        ],
        rows,
        layout: 'auto',
      }],
    };
  },
});
