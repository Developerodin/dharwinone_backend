import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  SHIFTS_ACCESS, SHIFT_ASSIGNEE_PERMISSIONS, MAX_SCHEDULE_LIST, scheduleScope, scheduleDeps, hasAnyPermission, shapeShift,
} from './common.js';

// Assignee rosters are one extra query per shift; cap how many shifts get one.
const MAX_ROSTER_SHIFTS = 5;
const MAX_ROSTER_PEOPLE = 50;

/**
 * The Shifts page (shift.service queryShifts) plus, when asked, each shift's roster via
 * queryShiftAssignees — the page's GET /shifts/:id/assignees, which needs attendance.assign.
 * Shift definitions are company-wide on the page, so there is no row scope to AND in.
 */
export default defineTool({
  name: 'list_shifts',
  domain: 'schedule',
  kind: 'read',
  description:
    'List work shifts (name, start/end time, timezone, active). Use for "what shifts do we have", "how many ' +
    'shifts". includeAssignees adds who is assigned to each shift ("who works the night shift") — pass name ' +
    'to narrow to that shift. For ONE person\'s shift use get_work_schedule.',
  measure:
    'Shift DEFINITIONS on the Shifts page (active only unless activeOnly is false); assigneeCount counts ' +
    'Employee and Student profiles assigned the shift, one row per person.',
  input: Joi.object({
    name: Joi.string().min(1).max(80).description('Part of the shift name, e.g. "night".'),
    activeOnly: Joi.boolean().default(true),
    includeAssignees: Joi.boolean().default(false),
    limit: Joi.number().integer().min(1).max(MAX_SCHEDULE_LIST).default(25),
  }),
  access: SHIFTS_ACCESS,
  async execute({ name, activeOnly = true, includeAssignees = false, limit = 25 } = {}, ctx) {
    const user = scheduleScope(ctx);
    const deps = scheduleDeps(ctx);
    const filter = { ...(name ? { name } : {}), ...(activeOnly ? { isActive: true } : {}) };
    const page = await deps.queryShifts(filter, { limit, page: 1, sortBy: 'name:asc' });
    const shifts = (page?.results || []).map((s) => ({
      id: String(s._id ?? s.id ?? ''),
      ...shapeShift(s),
      isActive: s.isActive !== false,
    }));
    const out = { total: page?.totalResults ?? shifts.length, shifts };
    if (!includeAssignees) return out;

    if (!hasAnyPermission(user, SHIFT_ASSIGNEE_PERMISSIONS)) {
      return { ...out, assigneesHidden: 'Seeing who is on a shift needs attendance.assign.' };
    }
    for (const shift of shifts.slice(0, MAX_ROSTER_SHIFTS)) {
      const roster = await deps.queryShiftAssignees(shift.id, { limit: MAX_ROSTER_PEOPLE, page: 1 });
      shift.assigneeCount = roster?.totalResults ?? 0;
      shift.assignees = (roster?.people || []).map((p) => ({
        name: p.name ?? null, employeeId: p.employeeId ?? null, type: p.type ?? null,
      }));
    }
    if (shifts.length > MAX_ROSTER_SHIFTS) out.assigneesTruncated = `Rosters shown for the first ${MAX_ROSTER_SHIFTS} shifts only.`;
    return out;
  },
  render(result) {
    if (!result || result.error) return null;
    const withRoster = result.shifts.some((s) => s.assigneeCount !== undefined);
    return {
      blocks: result.shifts.length ? [{
        type: 'table',
        id: 'shift-list',
        tableType: 'shift-list',
        title: `Shifts (${result.total})`,
        columns: [
          { key: 'name', label: 'Shift', priority: 'primary' },
          { key: 'hours', label: 'Hours', priority: 'primary' },
          { key: 'timezone', label: 'Timezone', priority: 'secondary' },
          ...(withRoster ? [{ key: 'assigneeCount', label: 'Assigned', priority: 'primary', format: 'number' }] : []),
        ],
        rows: result.shifts.map((s) => ({
          name: s.name ?? '—',
          hours: `${s.startTime ?? '?'}–${s.endTime ?? '?'}`,
          timezone: s.timezone ?? '—',
          ...(withRoster ? { assigneeCount: s.assigneeCount === undefined ? '—' : String(s.assigneeCount) } : {}),
        })),
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'list_shifts', label: 'shifts', total: result.total }] },
    };
  },
});
