import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { crosscheckScope, crosscheckDeps } from './common.js';
import { runFunnel } from './funnel.js';

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).description('YYYY-MM-DD');
const STAGE_LABELS = {
  application: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', accepted: 'Accepted',
  onboarding: 'Onboarding', hired: 'Joined',
};
const pct = (r) => (r == null ? '—' : `${r}%`);
const num = (n) => (n == null ? '—' : String(n));

export default defineTool({
  name: 'get_recruitment_funnel',
  domain: 'crosscheck',
  kind: 'read',
  description:
    'Recruitment funnel for applications CREATED in a window: stage conversions (application → screening → ' +
    'interview → offer → accepted → onboarding → joined, each with numerator and denominator), average time in ' +
    'each stage, the slowest stage, application-to-onboarding cycle time, recruiter pending workload (open ' +
    'applications / interviews / offers per recruiter) and, with compareTo "previous", the same for the previous ' +
    'period (previous month for a whole-month window). Narrow with jobId or recruiter (name or "me"). ' +
    'Do NOT use for counts of applications by status right now (list_applications / get_job_stats) or for ' +
    'people-in-two-modules questions (run_cross_check).',
  measure:
    'Applications created in the window in the viewer\'s Applications-page scope, one per job + applicant. ' +
    'Reached = entered the stage or a later one; stage dates from status history when an application has it, ' +
    'else interview / offer / placement dates (basis says how many used each).',
  input: Joi.object({
    window: Joi.object({ from: day.required(), to: day.required() })
      .description('Applications created in these IST days. Default: the last 30 days.'),
    jobId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).description('Job id from an earlier job tool result.'),
    recruiter: Joi.string().min(1).max(120).description('Recruiter name, or "me": jobs they are assigned to or created.'),
    compareTo: Joi.string().valid('previous').description('Also compute the previous period, for month-vs-month.'),
    limit: Joi.number().integer().min(1).max(50).default(10).description('Recruiter workload rows (default 10).'),
  }),
  access: { note: 'sections: cohort needs candidates.read (Applications page); workload interviews / offers need their page permission' },
  timeoutMs: 15000,
  async execute(args = {}, ctx) {
    const user = crosscheckScope(ctx);
    return runFunnel(args, { user, deps: crosscheckDeps(ctx), ctx });
  },
  render(result) {
    const f = result?.funnel;
    if (!f || f.status !== 'ok') return null;
    const blocks = [{
      type: 'table',
      id: 'recruitment-funnel',
      tableType: 'recruitment-funnel',
      title: `Recruitment funnel ${result.window.from} to ${result.window.to} (${f.cohort.atLeast ? 'at least ' : ''}${f.applications} applications)`,
      columns: [
        { key: 'stage', label: 'Stage', priority: 'primary' },
        { key: 'reached', label: 'Reached', priority: 'primary' },
        { key: 'conversion', label: 'From previous stage', priority: 'primary' },
      ],
      rows: f.stages.map((s) => {
        const conv = f.conversions.find((c) => c.to === s.stage && (s.stage !== 'interview' || c.from === 'application'));
        return {
          stage: STAGE_LABELS[s.stage],
          reached: s.stage === 'screening' ? `${s.reached} (history only)` : String(s.reached),
          conversion: conv ? `${pct(conv.rate)} (${conv.numerator}/${conv.denominator})` : '—',
        };
      }),
      layout: 'auto',
    }];
    const w = result.recruiterWorkload;
    if (w?.status === 'ok' && w.rows?.length) {
      blocks.push({
        type: 'table',
        id: 'recruiter-workload',
        tableType: 'recruiter-workload',
        title: `Recruiter pending workload (${w.total})`,
        columns: [
          { key: 'recruiter', label: 'Recruiter', priority: 'primary' },
          { key: 'openApplications', label: 'Open applications', priority: 'primary' },
          { key: 'openInterviews', label: 'Open interviews', priority: 'secondary' },
          { key: 'openOffers', label: 'Open offers', priority: 'secondary' },
        ],
        rows: w.rows.map((r) => ({
          recruiter: r.recruiter ?? '—', openApplications: num(r.openApplications),
          openInterviews: num(r.openInterviews), openOffers: num(r.openOffers),
        })),
        layout: 'auto',
      });
    }
    return { blocks, facts: { counts: [{ kind: 'get_recruitment_funnel', label: 'applications', total: f.applications }] } };
  },
});
