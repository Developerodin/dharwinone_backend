import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  INTERVIEWS_ACCESS, MAX_LIST_LIMIT, hiringScope, formatInterviewers, hiringCountFacts,
} from './common.js';
import {
  interviewDetailFilters, interviewDetailDeps, interviewExtraClauses, detailInterviewFilter, conflictsFor, jobTitlesFor,
} from './interviewDetail.js';

export default defineTool({
  name: 'list_interviews',
  domain: 'hiring',
  kind: 'read',
  description:
    'List ATS interviews (never internal meetings), latest slot first: candidate, job position, interviewers, ' +
    'time, status and result. Use for "interviews today", "<candidate>\'s interview", "who is interviewing ' +
    'for <job>", "which interviews have no result yet" (filters.resultMissing), "panel clashes" ' +
    '(filters.overlapping — each row then lists what it clashes with, which can be an interview that started just before the window). total is the full count even when ' +
    'fewer rows come back.',
  measure:
    'Interview RECORDS (one per scheduled interview round) you are allowed to see on the Interviews page ' +
      '(interviews manage = all, read = your own); every status and result unless filtered.',
  input: Joi.object({
    filters: interviewDetailFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: INTERVIEWS_ACCESS,
  async execute({ filters = {}, page, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = interviewDetailDeps(ctx);
    const { clauses, overlaps } = await interviewExtraClauses(filters, user, deps);
    const res = await deps.queryMeetings(
      detailInterviewFilter(filters, clauses), { page, limit, sortBy: 'scheduledAt:desc' }, user,
    );
    const jobTitle = await jobTitlesFor(res?.results, deps);
    return {
      total: res?.totalResults ?? 0,
      page: res?.page ?? page,
      totalPages: res?.totalPages ?? 0,
      records: (res?.results || []).map((m) => {
        const id = String(m.id ?? m._id ?? '');
        const conflicts = conflictsFor(overlaps, id);
        return {
          id,
          title: m.title ?? null,
          candidate: m.candidate?.name ?? null,
          applicationId: m.applicationId ? String(m.applicationId) : null,
          jobPosition: jobTitle(m),
          interviewers: formatInterviewers(m),
          scheduledAt: m.scheduledAt ?? null,
          timezone: m.timezone ?? null,
          interviewType: m.interviewType ?? null,
          status: m.status ?? null,
          result: m.interviewResult ?? null,
          ...(conflicts ? { conflicts } : {}),
        };
      }),
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
