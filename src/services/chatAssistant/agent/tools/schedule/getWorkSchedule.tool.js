import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { personRecordsDeps, runPersonList } from '../employees/common.js';
import {
  scheduleScope, scheduleDeps, userIdOf, hasAnyPermission, loadScheduleProfile, shapeShift, assignedHolidays,
  todayStartIso, OTHER_SCHEDULE_PERMISSIONS,
} from './common.js';

const MAX_HOLIDAYS = 20;

/**
 * Narrowed replacement for the legacy fetch_employee_overview / fetch_my_shift: shift, week-off and
 * ASSIGNED holidays for the viewer (default) or one named employee. Leaves, attendance and backdated
 * requests are their own tools. Another person resolves through executeEmployeeQuery (list_employees'
 * executor), so it gets the Employees page's permission AND row scope — never a role-name check.
 */
export default defineTool({
  name: 'get_work_schedule',
  domain: 'schedule',
  kind: 'read',
  description:
    'Work schedule of the signed-in user (person omitted) or one named employee: assigned shift (name, ' +
    'start/end time, timezone), week-off days, upcoming ASSIGNED holidays and leaves allowed. Use for "my ' +
    'shift", "what time do I work", "what is my week off", "what shift is Priya on", "Priya\'s holidays".',
  input: Joi.object({
    person: Joi.string().min(1).max(120)
      .description('Name, email or employee id of another employee. Omit for the signed-in user.'),
  }),
  access: {
    note: 'self always; another person needs an Employees-page read permission and is row-scoped by executeEmployeeQuery',
  },
  async execute({ person } = {}, ctx) {
    const user = scheduleScope(ctx);
    const deps = scheduleDeps(ctx);
    let profile;

    if (person) {
      if (!hasAnyPermission(user, OTHER_SCHEDULE_PERMISSIONS)) {
        return { error: 'You can only see your own schedule (another person needs Employees page access).' };
      }
      const found = await runPersonList({
        filters: { search: person }, ownerUserRole: 'employee', page: 1, limit: 5, user, deps: personRecordsDeps(ctx),
      });
      if (found.error) return { error: found.error };
      if (found.records.length !== 1) {
        return {
          searchedFor: person,
          matches: found.records.map((r) => ({ name: r.name, employeeId: r.employeeId, designation: r.designation })),
        };
      }
      profile = await loadScheduleProfile(deps.Employee, { _id: found.records[0].id });
      if (!profile) return { searchedFor: person, matches: [] };
    } else {
      profile = await loadScheduleProfile(deps.Employee, { owner: userIdOf(user) });
      // Trainees keep shift / week-off / holidays on their Student profile.
      if (!profile) profile = await loadScheduleProfile(deps.Student, { user: userIdOf(user) });
      if (!profile) {
        return { error: 'No employee or student profile is linked to your account, so there is no schedule to show.' };
      }
    }

    const holidays = assignedHolidays(profile, { from: todayStartIso() });
    return {
      self: !person || String(profile.owner ?? '') === userIdOf(user),
      name: profile.fullName ?? (person ? null : user.name ?? null),
      employeeId: profile.employeeId ?? null,
      shift: shapeShift(profile.shift),
      weekOff: Array.isArray(profile.weekOff) ? profile.weekOff : [],
      upcomingHolidays: holidays.slice(0, MAX_HOLIDAYS),
      upcomingHolidayCount: holidays.length,
      leavesAllowed: profile.leavesAllowed ?? null,
    };
  },
  render(result) {
    if (!result || result.error || result.matches) return null;
    const s = result.shift;
    return {
      blocks: [{
        type: 'table',
        id: 'work-schedule',
        tableType: 'work-schedule',
        title: `Work schedule${result.name ? ` — ${result.name}` : ''}`,
        columns: [
          { key: 'field', label: 'Item', priority: 'primary' },
          { key: 'value', label: 'Value', priority: 'primary' },
        ],
        rows: [
          { field: 'Shift', value: s ? `${s.name ?? '—'} (${s.startTime ?? '?'}–${s.endTime ?? '?'} ${s.timezone ?? ''})`.trim() : 'Not assigned' },
          { field: 'Week off', value: result.weekOff.length ? result.weekOff.join(', ') : 'None set' },
          { field: 'Upcoming holidays', value: String(result.upcomingHolidayCount) },
          { field: 'Leaves allowed', value: result.leavesAllowed == null ? '—' : String(result.leavesAllowed) },
        ],
        layout: 'auto',
      }],
    };
  },
});
