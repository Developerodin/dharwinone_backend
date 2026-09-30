import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { crosscheckScope, crosscheckDeps, ROW_LIMIT, MAX_ROW_LIMIT, SET_CAP } from './common.js';
import { CHECKS, CHECK_NAMES, runCheck } from './checks.js';

const COLUMN_LABELS = {
  name: 'Name', employeeId: 'ID', job: 'Job', joiningDate: 'Joining', placementStatus: 'Placement',
  preBoardingStatus: 'Pre-boarding', joinedOn: 'Joined', coursesCompleted: 'Courses done', activeProjects: 'Active projects',
  designation: 'Designation', overdueTasks: 'Overdue tasks', tasksDueToday: 'Due today', leaveType: 'Leave',
  meetings: 'Meetings', interviewOn: 'Interview', jobPosition: 'Position', acceptedOn: 'Accepted', bgvStatus: 'BGV',
  bgvCompletedOn: 'BGV done', orgChart: 'Org chart', course: 'Course', quizScore: 'Quiz %', bestJob: 'Best job',
  matchPct: 'Match %', applicationStatus: 'Status', status: 'Status', lastChange: 'Last change',
  lastChangeBasis: 'Based on',
};

const cell = (v) => {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return Object.entries(v).map(([k, n]) => `${k} ${n}`).join(', ');
  return String(v);
};

export default defineTool({
  name: 'run_cross_check',
  domain: 'crosscheck',
  kind: 'read',
  description:
    'Answers questions that JOIN two modules — people in one group but not (or also) in another, e.g. joining ' +
    'next week with pre-boarding not done, trained but on no project, absent today with tasks due, on leave ' +
    'tomorrow with an interview, passed interview but no offer, BGV done but not onboarding. query picks the ' +
    'named check (the enum names say what each one checks). ' +
    'args: available_with_training_score takes skill + minScore; bench_matches_recent_jobs takes jobKeyword + ' +
    'jobCount; referred_screened_never_interviewed takes salesAgent; applications_unchanged takes businessDays. ' +
    'Do NOT use for a question about one module only (use that module\'s tool) or for funnel / conversion rates ' +
    '(get_recruitment_funnel).',
  measure:
    `Set A minus / intersect set B, each built from its page's own scope and capped at ${SET_CAP} ids; total is ` +
    'the full count of people (or applications) in the result, rows at most limit. atLeast = a set hit the cap.',
  input: Joi.object({
    query: Joi.string().valid(...CHECK_NAMES).required(),
    args: Joi.object({
      skill: Joi.string().min(1).max(80).description('available_with_training_score: word in the course name, e.g. "React".'),
      minScore: Joi.number().integer().min(0).max(100).description('available_with_training_score: minimum quiz %, default 70.'),
      jobKeyword: Joi.string().min(1).max(80).description('bench_matches_recent_jobs: job search text.'),
      jobCount: Joi.number().integer().min(1).max(10).description('bench_matches_recent_jobs: newest N jobs, default 5.'),
      salesAgent: Joi.string().min(1).max(120).description('referred_screened_never_interviewed: sales agent name, or "me".'),
      businessDays: Joi.number().integer().min(1).max(60).description('applications_unchanged: default 5.'),
    }).default({}),
    limit: Joi.number().integer().min(1).max(MAX_ROW_LIMIT).default(ROW_LIMIT),
  }),
  access: { note: 'per set: each set needs its own page permission; a set the viewer lacks makes the whole check restricted' },
  timeoutMs: 15000,
  async execute({ query, args = {}, limit = ROW_LIMIT } = {}, ctx) {
    const user = crosscheckScope(ctx);
    const deps = crosscheckDeps(ctx);
    return runCheck(query, args, { user, deps, ctx }, limit);
  },
  render(result) {
    if (!result || result.status !== 'ok' || !Array.isArray(result.rows)) return null;
    if (!result.rows.length) return { blocks: [], facts: { counts: [{ kind: 'run_cross_check', label: 'people', total: result.total }] } };
    const keys = [...new Set(result.rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'employeeProfile');
    return {
      blocks: [{
        type: 'table',
        id: `crosscheck-${result.query}`,
        tableType: 'crosscheck',
        title: `${CHECKS[result.query]?.summary ?? result.query} (${result.atLeast ? 'at least ' : ''}${result.total})`,
        columns: keys.map((k, i) => ({ key: k, label: COLUMN_LABELS[k] ?? k, priority: i < 3 ? 'primary' : 'secondary' })),
        rows: result.rows.map((r) => Object.fromEntries(keys.map((k) => [k, cell(r[k])]))),
        layout: 'auto',
      }],
      facts: { counts: [{ kind: 'run_cross_check', label: 'people', total: result.total }] },
    };
  },
});
