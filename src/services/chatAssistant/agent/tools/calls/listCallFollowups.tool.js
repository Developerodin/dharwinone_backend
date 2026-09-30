import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { CALLS_ACCESS, MAX_LIST_LIMIT, callsScope, callsDeps, viewerCan, callCountFacts } from './common.js';
import { FOLLOWUP_KINDS, APPLICATIONS_PAGE_PERMISSION, runFollowups } from './followups.js';

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.');

const TITLES = {
  callbackRequested: 'Callbacks due',
  callbackOverdue: 'Callbacks overdue',
  notYetCalled: 'Applicants not yet called',
};

export default defineTool({
  name: 'list_call_followups',
  domain: 'calls',
  kind: 'read',
  description:
    'Job applicants who still need a call: callbackRequested = the candidate asked the AI agent to call back ' +
    'and that callback is still due; callbackOverdue = the requested time passed and the callback was not ' +
    'placed; notYetCalled = open applications with no call record at all. Use for "who asked for a callback", ' +
    '"which callbacks are overdue", "which applicants haven\'t been called yet for <job>". total is the full ' +
    'count even when fewer rows come back. Counts only → get_call_metrics.',
  measure:
    'Open job APPLICATIONS on the Applications page (not Offered / Hired / Rejected / withdrawn), in that ' +
      'page\'s scope; notYetCalled = no AI verification call and no call record for that candidate + job ' +
      '(dialer calls are not linked to applications, so a candidate rung only from the dialer still counts).',
  input: Joi.object({
    kind: Joi.string().valid(...FOLLOWUP_KINDS).required(),
    jobId: Joi.string().pattern(/^[a-fA-F0-9]{24}$/).description('Job id from a jobs tool, to limit to one job.'),
    appliedBetween: Joi.object({ from: isoDay, to: isoDay })
      .description('Application date window, inclusive whole days (IST).'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: CALLS_ACCESS,
  async execute({ kind, jobId, appliedBetween, limit } = {}, ctx) {
    const user = callsScope(ctx);
    // Applications page gate (job-application routes: requirePermissions('candidates.read')).
    if (!viewerCan(user, APPLICATIONS_PAGE_PERMISSION)) {
      return { forbidden: true, error: `Needs the Applications page permission (${APPLICATIONS_PAGE_PERMISSION}).` };
    }
    const filters = { ...(jobId ? { jobId } : {}), ...(appliedBetween ? { appliedBetween } : {}) };
    const out = await runFollowups(kind, filters, user, callsDeps(ctx), { limit: Math.min(limit || 20, MAX_LIST_LIMIT) });
    return { kind, ...out, filtersApplied: filters };
  },
  render(result) {
    if (!result || result.error || result.forbidden) return null;
    const blocks = result.records?.length ? [{
      type: 'table',
      id: 'call-followups',
      tableType: 'call-followups',
      title: `${TITLES[result.kind]} (${result.total})`,
      columns: [
        { key: 'applicant', label: 'Applicant', priority: 'primary' },
        { key: 'job', label: 'Job', priority: 'primary' },
        { key: 'when', label: result.kind === 'notYetCalled' ? 'Applied' : 'Callback at', priority: 'primary' },
        { key: 'status', label: 'Application status', priority: 'secondary' },
      ],
      rows: result.records.map((r) => {
        const when = result.kind === 'notYetCalled' ? r.appliedAt : r.callbackAt;
        return {
          applicant: r.applicant ?? '—',
          job: r.job ?? '—',
          when: when ? new Date(when).toISOString() : '—',
          status: r.applicationStatus ?? '—',
        };
      }),
      layout: 'auto',
    }] : [];
    return { blocks, facts: callCountFacts('list_call_followups', result.total, 'applications') };
  },
});
