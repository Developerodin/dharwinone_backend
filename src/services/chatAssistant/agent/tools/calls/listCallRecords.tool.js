import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  CALLS_ACCESS, MAX_LIST_LIMIT, callFilters, callsScope, callsDeps, runCallList, callCountFacts,
} from './common.js';

export default defineTool({
  name: 'list_call_records',
  domain: 'calls',
  kind: 'read',
  description:
    'List phone call records (Communication → Call Records), newest first: call id, when, person, to / from ' +
    'number (fromNumber is the caller ID shown), call type, direction, provider, duration, status, who hung up ' +
    '(hangupBy / hangupReason, AI agent calls only), AI outcome ' +
    '(only with the Call AI toggle) and whether a recording exists. Use for "show today\'s calls", "last calls ' +
    'to Rahul", "failed calls this week". total is the full count even when fewer rows come back. For one ' +
    'call\'s AI summary, transcript or recording use get_call_record.',
  measure:
    'Call RECORDS you can see on the Call Records page (every call for Administrators, otherwise calls you ' +
      'placed or on jobs / candidates you own); every status unless filters say otherwise.',
  input: Joi.object({
    filters: callFilters,
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: CALLS_ACCESS,
  async execute({ filters, limit } = {}, ctx) {
    const user = callsScope(ctx);
    return runCallList({ filters: filters || {}, limit: limit || 20, user, deps: callsDeps(ctx) });
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'call-list',
      tableType: 'call-list',
      title: `Calls (${result.total})`,
      columns: [
        { key: 'person', label: 'Person', priority: 'primary' },
        { key: 'when', label: 'When', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'durationSeconds', label: 'Duration (s)', priority: 'secondary' },
        { key: 'toNumber', label: 'Number', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        person: r.person ?? '—',
        when: r.when ? new Date(r.when).toISOString() : '—',
        status: r.status ?? '—',
        durationSeconds: r.durationSeconds != null ? String(r.durationSeconds) : '—',
        toNumber: r.toNumber ?? '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: callCountFacts('list_call_records', result.total) };
  },
});
