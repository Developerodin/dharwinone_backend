import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  INSIGHTS_ACCESS, COMPOSITE_TIMEOUT_MS, SECTION_TIMEOUT_MS, istToday, resolveWindow, runSections, sectionFrom,
  statusLabel,
} from './common.js';
import { MODULES, runDigest } from './digestItems.js';

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.');
const total = (r) => ({ value: r.total ?? null });
const groupsToObject = (groups) => Object.fromEntries((groups || []).map((g) => [g.value, g.count]));

function presentToday(r) {
  if (r.futureDate) return { status: 'notRecorded', value: null, note: r.note };
  return { value: r.perDay?.[0]?.counts?.Present ?? 0, detail: { population: r.total ?? null } };
}

function openTasks(r) {
  const completed = (r.groups || []).find((g) => g.value === 'completed')?.count ?? 0;
  return { value: (r.total ?? 0) - completed, detail: { overdue: r.overdue ?? null, blocked: r.blocked ?? null, scope: r.scope ?? null } };
}

/** Each module's key numbers: one Wave 1 count tool per metric, under the viewer's own access. */
const MODULE_METRICS = Object.freeze({
  recruitment: [
    { id: 'open_jobs', label: 'Open jobs (Active)', tool: 'count_jobs', args: () => ({}) },
    {
      id: 'applications', label: 'Applications', tool: 'count_applications', args: () => ({}),
      pick: (r) => ({ value: r.total ?? null, detail: { byStatus: r.breakdown ?? null } }),
      note: 'The applications tools take no date window, so this is every application you can see.',
    },
    {
      id: 'interviews', label: 'Interviews scheduled in the window', tool: 'count_interviews',
      args: ({ window }) => ({ filters: { scheduledBetween: window } }),
      pick: (r) => ({ value: r.total ?? null, detail: { byStatus: r.byStatus ?? null, byResult: r.byResult ?? null } }),
    },
    {
      id: 'offers', label: 'Offers created in the window', tool: 'count_offers',
      args: ({ window }) => ({ filters: { createdBetween: window } }),
      pick: (r) => ({ value: r.total ?? null, detail: { byStatus: r.byStatus ?? null } }),
    },
    {
      id: 'joiners', label: 'Joined in the window', tool: 'count_placements',
      args: ({ window }) => ({ filters: { status: 'Joined', joiningBetween: window } }),
    },
  ],
  hr: [
    { id: 'employees', label: 'Current employees', tool: 'count_employees', args: () => ({}) },
    {
      id: 'present_today', label: 'Present today', tool: 'get_attendance_summary',
      args: ({ today }) => ({ window: { from: today, to: today } }), pick: presentToday,
    },
    { id: 'on_leave_today', label: 'On leave today', tool: 'who_is_on_leave_today', args: () => ({}) },
    {
      id: 'onboarding', label: 'Placements in onboarding', tool: 'count_placements',
      args: () => ({ filters: { status: 'Onboarding' } }),
    },
  ],
  pm: [
    {
      id: 'projects', label: 'Projects', tool: 'count_projects', args: () => ({ groupBy: 'status' }),
      pick: (r) => ({ value: r.total ?? null, detail: { byStatus: groupsToObject(r.groups), scope: r.scope ?? null } }),
    },
    { id: 'open_tasks', label: 'Open tasks', tool: 'count_tasks', args: () => ({ groupBy: 'status' }), pick: openTasks },
    {
      id: 'utilisation', label: 'Employees by active projects', tool: 'get_allocation', args: () => ({ mode: 'summary' }),
      pick: (r) => ({
        value: r.total ?? null,
        detail: {
          byActiveProjects: r.byActiveProjects ?? null,
          atOrOverLimit: r.atOrOverLimit ?? null,
          unallocated: r.unallocated ?? null,
          overloaded: r.overloaded ?? null,
        },
      }),
    },
  ],
  bench: [
    {
      id: 'unallocated', label: 'Employees on no active project', tool: 'get_allocation', args: () => ({ mode: 'summary' }),
      pick: (r) => ({ value: r.byActiveProjects?.['0'] ?? null, detail: { fullyUnallocated: r.unallocated ?? null, population: r.total ?? null } }),
    },
    {
      id: 'external_jobs', label: 'External jobs (Active)', tool: 'count_jobs',
      args: () => ({ filters: { jobOrigin: 'external' } }),
    },
  ],
});

export default defineTool({
  name: 'get_operations_summary',
  domain: 'insights',
  kind: 'read',
  description:
    'One module\'s headline numbers plus that module\'s attention items. recruitment: open jobs, applications, ' +
    'interviews, offers, joiners. hr: employees, present today, on leave today, onboarding. pm: projects, open / ' +
    'overdue tasks, utilisation (people on 0 / 1 / 2 / 3+ active projects). bench: employees on no project, ' +
    'external jobs. Use for "recruitment summary", "HR report for this week", "PM status", "bench summary". ' +
    'Not for one number (that domain\'s count tool) or a cross-module "what needs attention" (get_attention_digest).',
  measure:
    'Each number is one module tool\'s count under your own access (its page\'s row scope): interviews by slot, ' +
      'offers by creation date and joiners by joining date inside the window; the rest are current totals.',
  input: Joi.object({
    module: Joi.string().valid(...MODULES).required(),
    window: Joi.object({ from: isoDay, to: isoDay })
      .description('Whole IST days for interviews, offers, joiners and the windowed attention items. Default today.'),
  }),
  access: INSIGHTS_ACCESS,
  timeoutMs: COMPOSITE_TIMEOUT_MS,
  async execute({ module, window } = {}, ctx) {
    const now = (ctx?.deps?.now ?? (() => new Date()))();
    const today = istToday(now);
    const w = resolveWindow(window, now);
    const defs = MODULE_METRICS[module];
    const [outcomes, digest] = await Promise.all([
      runSections(defs.map((m) => ({ name: m.tool, args: m.args({ window: w, today }), timeoutMs: SECTION_TIMEOUT_MS })), ctx),
      runDigest({ scope: 'all', module, window: w }, ctx),
    ]);
    const metrics = defs.map((m, i) => {
      const section = sectionFrom(outcomes[i], m.pick ?? total);
      const base = { id: m.id, label: m.label, source: m.tool };
      if (section.status === 'restricted') return { ...base, status: 'restricted' };
      return { ...base, ...section, ...(m.note ? { note: m.note } : {}) };
    });
    return {
      module,
      window: w,
      metrics,
      restricted: [
        ...metrics.filter((m) => m.status === 'restricted').map((m) => m.label),
        ...digest.restricted,
      ],
      failed: [
        ...metrics.filter((m) => m.status === 'error' || m.status === 'timeout').map((m) => ({ label: m.label, status: m.status })),
        ...digest.failed,
      ],
      attention: digest.items,
    };
  },
  render(result) {
    if (!result?.metrics) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'operations-summary',
        tableType: 'operations-summary',
        title: `${result.module[0].toUpperCase()}${result.module.slice(1)} summary`,
        columns: [
          { key: 'label', label: 'Metric', priority: 'primary' },
          { key: 'value', label: 'Value', priority: 'primary' },
        ],
        rows: [
          ...result.metrics.map((m) => ({ label: m.label, value: m.status === 'ok' ? String(m.value ?? '—') : m.status })),
          ...result.attention.map((i) => ({ label: i.label, value: statusLabel(i) })),
        ],
        layout: 'auto',
      }],
    };
  },
});
