import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { ADVICE_ACCESS, MAX_LIST_LIMIT, adviceDeps, adviceScope, clampLimit } from './common.js';
import { KINDS } from './recommendKinds.js';

const bySubject = (a, b) => b.score - a.score || String(a.subject ?? '').localeCompare(String(b.subject ?? ''));

export default defineTool({
  name: 'recommend',
  domain: 'advice',
  kind: 'read',
  description:
    'Ranked recommendations from fixed rules, each with its reasons and evidence: follow_ups_today (your ' +
    'attention digest), next_candidate_to_contact (callback due > interested on the AI call but no interview > ' +
    'stale application), interview_order (who to interview first), allocate_to_project (needs project), ' +
    'training_before_assignment, bench_for_job (needs job), team_task_priorities (needs team), recruiter_capacity ' +
    '("where do we need another recruiter"). Use for "who should I…", "what first", "suggest", "recommend". Not ' +
    'for a plain list or count (use that domain\'s list / count tool) and not for why someone is blocked (explain_status).',
  measure:
    'Scores follow the rules returned with the result — not opinions. Every input is a module tool run under your ' +
    'access (restricted or failed sections are named in sections, never filled in); recruiter_capacity counts the ' +
    'active jobs and applications you can see.',
  input: Joi.object({
    kind: Joi.string().valid(...Object.keys(KINDS)).required(),
    project: Joi.string().trim().min(1).max(160).description('Project name — allocate_to_project.'),
    job: Joi.string().trim().min(1).max(200).description('Job id or title — bench_for_job.'),
    team: Joi.string().trim().min(1).max(120).description('Workforce team name — team_task_priorities.'),
    designation: Joi.string().trim().min(1).max(120)
      .description('Optional designation filter — allocate_to_project, training_before_assignment.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: ADVICE_ACCESS,
  timeoutMs: 15000,
  async execute({ kind, limit, ...args }, ctx) {
    const user = adviceScope(ctx);
    const spec = KINDS[kind];
    if (spec.needs && !args[spec.needs]) return { kind, error: `${kind} needs ${spec.needs}.` };
    const { run, runAll, now } = adviceDeps(ctx);
    const out = await spec.run(args, { run, runAll, now: now(), user }, ctx);
    const { items: ranked = [], notes, ...rest } = out;
    const items = [...ranked].sort(bySubject);
    return {
      kind,
      ...rest,
      total: items.length,
      items: items.slice(0, clampLimit(limit)),
      ...(notes?.length ? { notes } : {}),
    };
  },
  render(result) {
    if (!result?.items?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'recommend',
        tableType: 'recommend',
        title: `Recommended — ${result.kind.replace(/_/g, ' ')} (${result.total})`,
        columns: [
          { key: 'subject', label: 'Subject', priority: 'primary' },
          { key: 'score', label: 'Score', priority: 'primary' },
          { key: 'reasons', label: 'Why', priority: 'secondary' },
        ],
        rows: result.items.map((i) => ({ subject: i.subject ?? '—', score: String(i.score), reasons: i.reasons.join('; ') })),
        layout: 'auto',
      }],
      facts: { counts: [{ kind: 'recommend', label: 'recommendations', total: result.total }] },
    };
  },
});
