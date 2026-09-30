import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  MEETINGS_ACCESS, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, meetingFilters, meetingsScope, meetingsDeps, runMeetingQuery,
  meetingCountFacts,
} from './common.js';

const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');

export default defineTool({
  name: 'list_meetings',
  domain: 'meetings',
  kind: 'read',
  description:
    'List internal / team meetings (Communication → Meetings) with title, time, duration, type, status, ' +
    'hosts and hasRecording. Upcoming meetings come soonest first; otherwise newest first. Use for "what ' +
    'meetings do I have tomorrow", "show my next meetings", "which meetings ended today", "meetings I had ' +
    'earlier today", "meetings about onboarding". total is the full count even when fewer rows come back. ' +
    'Never for interviews.',
  measure:
    'Internal meeting RECORDS you can see on the Meetings page (every meeting with full meetings.* ' +
      'permissions, otherwise ones you created, host or are invited to); every status and both past and ' +
      'upcoming unless filters say otherwise. ATS interviews are not included.',
  input: Joi.object({
    filters: meetingFilters,
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  }),
  access: MEETINGS_ACCESS,
  async execute({ filters, limit } = {}, ctx) {
    const user = meetingsScope(ctx);
    return runMeetingQuery({ filters: filters || {}, limit: limit || DEFAULT_LIST_LIMIT, user, deps: meetingsDeps(ctx) });
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'meeting-list',
      tableType: 'meeting-list',
      title: `Meetings (${result.total})`,
      columns: [
        { key: 'title', label: 'Meeting', priority: 'primary' },
        { key: 'scheduledAt', label: 'When', priority: 'primary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'hosts', label: 'Hosts', priority: 'secondary' },
        { key: 'hasRecording', label: 'Recording', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        title: r.title ?? '—',
        scheduledAt: r.scheduledAt ? new Date(r.scheduledAt).toISOString() : '—',
        status: r.status ?? '—',
        hosts: r.hosts?.length ? r.hosts.join(', ') : '—',
        hasRecording: yesNo(r.hasRecording),
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: meetingCountFacts('list_meetings', result.total) };
  },
});
