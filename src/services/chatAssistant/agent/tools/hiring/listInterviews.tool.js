import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { interviewFilters } from './filters.js';
import {
  INTERVIEWS_ACCESS, MAX_LIST_LIMIT, hiringScope, hiringDeps, interviewMongoFilter, formatInterviewers,
  hiringCountFacts,
} from './common.js';

export default defineTool({
  name: 'list_interviews',
  domain: 'hiring',
  kind: 'read',
  description:
    'List ATS interviews (never internal meetings), latest slot first: candidate, job position, interviewers, ' +
    'time, status and result. Use for "interviews today", "<candidate>\'s interview", "who is interviewing ' +
    'for <job>". total is the full count even when fewer rows come back.',
  measure:
    'Interview RECORDS (one per scheduled interview round) you are allowed to see on the Interviews page ' +
      '(interviews manage = all, read = your own); every status and result unless filtered.',
  input: Joi.object({
    filters: interviewFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: INTERVIEWS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = hiringDeps(ctx);
    const res = await deps.queryMeetings(interviewMongoFilter(filters), { page, limit, sortBy: 'scheduledAt:desc' }, user);
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: (res?.results || []).map((m) => ({
        id: String(m.id ?? m._id ?? ''),
        title: m.title ?? null,
        candidate: m.candidate?.name ?? null,
        jobPosition: m.jobPosition ?? null,
        interviewers: formatInterviewers(m),
        scheduledAt: m.scheduledAt ?? null,
        timezone: m.timezone ?? null,
        interviewType: m.interviewType ?? null,
        status: m.status ?? null,
        result: m.interviewResult ?? null,
      })),
      filtersApplied: filters,
    };
  },
  render(result) {
    if (!result || result.error) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'interview-list',
      tableType: 'interview-list',
      title: `Interviews (${result.total})`,
      columns: [
        { key: 'candidate', label: 'Candidate', priority: 'primary' },
        { key: 'jobPosition', label: 'Position', priority: 'primary' },
        { key: 'scheduledAt', label: 'When', priority: 'primary', format: 'date' },
        { key: 'interviewers', label: 'Interviewers', priority: 'secondary' },
        { key: 'status', label: 'Status', priority: 'primary' },
        { key: 'result', label: 'Result', priority: 'secondary' },
      ],
      rows: result.records.map((r) => ({
        candidate: r.candidate ?? '—',
        jobPosition: r.jobPosition ?? '—',
        scheduledAt: r.scheduledAt ?? '—',
        interviewers: r.interviewers ?? '—',
        status: r.status ?? '—',
        result: r.result ?? '—',
      })),
      layout: 'auto',
    }] : [];
    return { blocks, facts: hiringCountFacts('list_interviews', 'interviews', result.total) };
  },
});
