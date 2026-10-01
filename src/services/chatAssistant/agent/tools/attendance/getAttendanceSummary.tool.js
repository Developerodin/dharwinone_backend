import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dateStrInTz } from '../../../../../utils/zonedTime.js';
import { enrichAttendanceSummary } from '../../../attendanceAnalytics.js';
import {
  ATTENDANCE_SUMMARY_ACCESS, windowSchema, attendanceScope, attendanceDeps, dayKeys, simpleTable, canSeeTeams,
} from './common.js';
import {
  TEAM_GROUP_DENIED, TEAM_GROUP_NOTE, ATTENDANCE_GROUP_METRIC, loadAttendanceAssignments, rollupAttendance,
} from './grouping.js';

const MAX_WINDOW_DAYS = 92;
const DAY_STATUSES = ['Present', 'Absent', 'Leave', 'Holiday', 'WeekOff', 'Incomplete'];

function eachIsoDay(from, to) {
  const days = [];
  const cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Per-employee status comes from aggregateOrgAttendance, which only emits `employees` for a one-day
 * window. A single unfiltered day reuses that array. Any longer window (or a status-filtered day,
 * whose list is already narrowed) re-reads each day.
 *
 * ponytail: one aggregator pass per day, capped by the 92-day window. A row that already carries
 * `owner` and `department` is grouped from those (see loadAttendanceAssignments). Upgrade: return
 * employeeDays (owner, department, status, date) from aggregateOrgAttendance in one pass and delete this loop.
 */
async function groupAttendance({ from, to, status, groupBy, raw, deps }) {
  const days = eachIsoDay(from, to);
  const employeeDays = [];
  if (days.length === 1 && !status) {
    for (const row of raw.employees || []) employeeDays.push({ ...row, date: days[0] });
  } else {
    for (const iso of days) {
      const day = new Date(`${iso}T00:00:00.000Z`);
      const dayRaw = await deps.aggregateOrgAttendance({ from: day, to: day });
      for (const row of dayRaw.employees || []) employeeDays.push({ ...row, date: iso });
    }
  }
  const assignments = await loadAttendanceAssignments(employeeDays, deps, { includeTeams: groupBy === 'team' });
  const { groups, otherCount } = rollupAttendance(employeeDays, assignments, groupBy);
  return {
    groupBy,
    metric: ATTENDANCE_GROUP_METRIC,
    ...(groupBy === 'team' ? { note: TEAM_GROUP_NOTE } : {}),
    groups,
    ...(otherCount ? { otherCount } : {}),
  };
}

export default defineTool({
  name: 'get_attendance_summary',
  domain: 'attendance',
  kind: 'read',
  description:
    'Company-wide attendance for a day or range: per-day counts of employees Present / Absent / Leave / Holiday / ' +
    'WeekOff / Incomplete, and the average daily Present. For ONE day it also lists each employee\'s status and ' +
    'punch times (narrow with status). groupBy "department" (employee profile department) or "team" (workforce ' +
    'team; needs teams.read; a person on several teams counts in each) ranks groups by the share of ' +
    'employee-days Present. Blank department and no team are "Not set". Use for "how many were present ' +
    'yesterday", "company attendance in July", "who was absent on Monday", "which department had the highest ' +
    'attendance". One person\'s attendance is get_attendance.',
  measure:
    'EMPLOYEE-DAYS: every current Employee-role profile gets one computed status per day (week-offs, holidays, ' +
      'joining/resign dates applied); total is the number of employees in the population.',
  input: Joi.object({
    window: windowSchema.required(),
    status: Joi.string().valid(...DAY_STATUSES).description('Single-day employee list: only this status. Does not change groupBy totals.'),
    groupBy: Joi.string().valid('department', 'team')
      .description('Break employee-days down by employee-profile department or workforce team.'),
  }),
  access: ATTENDANCE_SUMMARY_ACCESS,
  async execute({ window, status, groupBy } = {}, ctx) {
    const user = attendanceScope(ctx);
    const { from, to } = dayKeys(window);
    const spanDays = Math.round((to - from) / 86400000) + 1;
    if (spanDays > MAX_WINDOW_DAYS) {
      return { error: `Pick a window of at most ${MAX_WINDOW_DAYS} days (asked for ${spanDays}).` };
    }
    if (groupBy === 'team' && !canSeeTeams(user)) return { error: TEAM_GROUP_DENIED };
    // Day keys are IST days: a UTC "today" called 00:00–05:30 IST today a future date.
    const now = (ctx?.deps?.now ?? (() => new Date()))();
    const todayKey = new Date(`${dateStrInTz(now, DEFAULT_TIMEZONE)}T00:00:00.000Z`);
    if (from > todayKey) {
      return { futureDate: true, total: 0, note: 'Attendance is only recorded for days that have already happened.' };
    }
    const deps = attendanceDeps(ctx);
    // Population is the Employee role — no adminId subtree (inventory bug B2).
    const raw = await deps.aggregateOrgAttendance({ from, to, statusFilter: status });
    const out = enrichAttendanceSummary(raw);
    const grouped = groupBy ? await groupAttendance({ from, to, status, groupBy, raw, deps }) : null;
    return {
      window,
      total: out.total,
      avgDailyPresent: out.avgDailyPresent,
      daysCounted: out.dayCount,
      perDay: out.perDay,
      ...(out.employees?.length ? { employees: out.employees } : {}),
      ...(out.ignoredUnknownStatusRecords ? { ignoredUnknownStatusRecords: out.ignoredUnknownStatusRecords } : {}),
      ...(grouped || {}),
    };
  },
  render(result) {
    if (!result || result.error || result.futureDate) return null;
    const blocks = [];
    if (result.groups?.length) {
      blocks.push(simpleTable({
        id: 'attendance-groups',
        title: `Attendance by ${result.groupBy}`,
        columns: [['value', result.groupBy === 'team' ? 'Team' : 'Department'], ['people', 'People'],
          ['present', 'Present'], ['absent', 'Absent'], ['leave', 'Leave'], ['attendancePct', 'Attendance %']],
        rows: result.groups.map((g) => ({
          ...g,
          people: String(g.people),
          present: String(g.present),
          absent: String(g.absent),
          leave: String(g.leave),
          attendancePct: g.attendancePct == null ? null : `${g.attendancePct}%`,
        })),
      }));
    }
    if (result.employees?.length) {
      blocks.push(simpleTable({
        id: 'attendance-day',
        title: `Attendance on ${result.window.from} (${result.employees.length})`,
        columns: [['name', 'Name'], ['employeeId', 'ID', 'secondary'], ['status', 'Status'], ['punchIn', 'In'],
          ['punchOut', 'Out']],
        rows: result.employees,
      }));
    } else if (result.perDay?.length > 1) {
      blocks.push(simpleTable({
        id: 'attendance-range',
        title: `Attendance ${result.window.from} to ${result.window.to}`,
        columns: [['date', 'Date'], ['Present', 'Present'], ['Absent', 'Absent'], ['Leave', 'Leave'],
          ['Holiday', 'Holiday', 'secondary'], ['WeekOff', 'Week off', 'secondary']],
        rows: result.perDay.map((d) => ({
          date: d.date, ...Object.fromEntries(Object.entries(d.counts).map(([k, v]) => [k, String(v)])),
        })),
      }));
    }
    return { blocks };
  },
});
