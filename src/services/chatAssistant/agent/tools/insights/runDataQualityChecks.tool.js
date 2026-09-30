import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { INSIGHTS_ACCESS, COMPOSITE_TIMEOUT_MS, MAX_ROWS, guardedSection, trimRows, statusLabel } from './common.js';
import { QUALITY_CHECKS, CHECK_IDS, qualityDeps } from './qualityChecks.js';

export default defineTool({
  name: 'run_data_quality_checks',
  domain: 'insights',
  kind: 'read',
  description:
    'Data-quality audit: incomplete employee profiles; candidates with no skills / education / work experience; ' +
    'employees with no assigned agent, no department or no org-chart group; duplicate phones / emails; ' +
    'applications with no referral; interviews with no result; offers missing salary or joining date; courses ' +
    'mapped to no position; tasks with no assignee or no due date; projects with no manager; expired EAD / visa. ' +
    'Use for "data quality", "missing data", "incomplete records", "what needs cleaning up". Pass checks to run ' +
    'only some. Not for one person\'s profile (the people tools) or live operational exceptions (get_attention_digest).',
  measure:
    'Each check counts records you can see (the owning page\'s row scope) that match its rule, with up to ' +
      'sampleSize examples; each check names its source field.',
  input: Joi.object({
    checks: Joi.array().items(Joi.string().valid(...CHECK_IDS)).min(1).unique()
      .description('Only these checks (default: all 17).'),
    sampleSize: Joi.number().integer().min(0).max(MAX_ROWS).default(MAX_ROWS)
      .description('Example rows per check (0 = counts only).'),
  }),
  access: INSIGHTS_ACCESS,
  timeoutMs: COMPOSITE_TIMEOUT_MS,
  async execute({ checks, sampleSize = MAX_ROWS } = {}, ctx) {
    const env = { user: ctx.user, ctx, deps: qualityDeps(ctx), sampleSize };
    const selected = checks?.length ? QUALITY_CHECKS.filter((c) => checks.includes(c.id)) : QUALITY_CHECKS;
    const outcomes = await Promise.all(selected.map((c) => guardedSection(() => c.run(env))));
    const results = selected.map((c, i) => {
      const { status, count = null, sample = [], ...extra } = outcomes[i];
      const base = { id: c.id, label: c.label, status, source: c.source };
      if (status === 'restricted') return { ...base, count: null, sample: [] };
      return {
        ...base,
        count: status === 'ok' ? count : null,
        sample: status === 'ok' ? trimRows(sample, sampleSize) : [],
        ...extra,
      };
    });
    return {
      checks: results,
      flagged: results.filter((r) => r.status === 'ok' && r.count > 0).length,
      restricted: results.filter((r) => r.status === 'restricted').map((r) => r.label),
      failed: results.filter((r) => r.status === 'error' || r.status === 'timeout').map((r) => ({ label: r.label, status: r.status })),
      notCaptured: results.filter((r) => r.status === 'notCaptured').map((r) => r.label),
    };
  },
  render(result) {
    if (!result?.checks?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'data-quality',
        tableType: 'data-quality',
        title: 'Data quality checks',
        columns: [
          { key: 'label', label: 'Check', priority: 'primary' },
          { key: 'count', label: 'Records', priority: 'primary' },
        ],
        rows: result.checks.map((c) => ({ label: c.label, count: `${statusLabel(c)}${c.atLeast ? '+' : ''}` })),
        layout: 'auto',
      }],
    };
  },
});
