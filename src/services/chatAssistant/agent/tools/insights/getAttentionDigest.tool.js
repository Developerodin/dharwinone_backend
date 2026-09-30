import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { INSIGHTS_ACCESS, COMPOSITE_TIMEOUT_MS, statusLabel } from './common.js';
import { MODULES, OFFER_PENDING_DAYS, runDigest } from './digestItems.js';

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.');

export default defineTool({
  name: 'get_attention_digest',
  domain: 'insights',
  kind: 'read',
  description:
    'What needs attention now, across modules: failed calls, overdue callbacks, applicants never called, ' +
    `interviews with no result, panel clashes, offers unanswered over ${OFFER_PENDING_DAYS} days, accepted offers ` +
    'with no pre-boarding, joiners still in pre-boarding, joining date passed, ready for BGV, incomplete punches, ' +
    'pending leave / backdated requests, overdue tasks, employees on no project. Use for "what needs my attention", ' +
    '"today\'s exceptions", "critical alerts", "who needs follow-up", a Monday briefing or end-of-day report, and ' +
    '"what changed since yesterday" (compareTo previous). Not for one metric (use that domain\'s count tool) and ' +
    'not for a module\'s headline numbers (get_operations_summary).',
  measure:
    'Each item is the count from one module tool under your own access (its page\'s row scope), plus up to 3 ' +
      'example rows; items without a window (backlogs) are the current state. Severity is a fixed rule, not a score.',
  input: Joi.object({
    scope: Joi.string().valid('mine', 'all').default('all')
      .description('mine = only items that have a "mine" filter (your calls, your leave, your backdated requests, ' +
        'your tasks); the rest are listed in notScopedToYou.'),
    module: Joi.string().valid(...MODULES, 'all').default('all')
      .description('recruitment, hr, pm (projects / tasks), bench (unallocated people) or all.'),
    window: Joi.object({ from: isoDay, to: isoDay })
      .description('Whole IST days for the windowed items (failed calls, panel clashes, incomplete punches). ' +
        'Default today.'),
    compareTo: Joi.string().valid('previous')
      .description('previous = the same windowed counts for the previous window of equal length ("since ' +
        'yesterday", "this month vs last"); items with no window are listed in noWindow.'),
  }),
  access: INSIGHTS_ACCESS,
  timeoutMs: COMPOSITE_TIMEOUT_MS,
  execute(args, ctx) {
    return runDigest(args, ctx);
  },
  render(result) {
    if (!result?.items?.length) return null;
    const compare = result.compareTo === 'previous';
    return {
      blocks: [{
        type: 'table',
        id: 'attention-digest',
        tableType: 'attention-digest',
        title: `Needs attention (${result.window.from === result.window.to ? result.window.from : `${result.window.from} to ${result.window.to}`})`,
        columns: [
          { key: 'label', label: 'Item', priority: 'primary' },
          { key: 'severity', label: 'Severity', priority: 'secondary' },
          { key: 'count', label: 'Count', priority: 'primary' },
          ...(compare ? [{ key: 'delta', label: 'Change', priority: 'primary' }] : []),
        ],
        rows: result.items.map((i) => ({
          label: i.label,
          severity: i.severity,
          count: statusLabel(i),
          ...(compare ? { delta: i.compare?.delta == null ? '—' : String(i.compare.delta) } : {}),
        })),
        layout: 'auto',
      }],
    };
  },
});
