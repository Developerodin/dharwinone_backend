import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dateStrInTz } from '../../../../../utils/zonedTime.js';
import { enrichAttendanceSummary } from '../../../attendanceAnalytics.js';
import {
  ATTENDANCE_SUMMARY_ACCESS, windowSchema, attendanceScope, attendanceDeps, dayKeys, simpleTable,
} from './common.js';

const MAX_WINDOW_DAYS = 92;
const DAY_STATUSES = ['Present', 'Absent', 'Leave', 'Holiday', 'WeekOff', 'Incomplete'];

export default defineTool({
  name: 'get_attendance_summary',
  domain: 'attendance',
  kind: 'read',
  description:
    'Company-wide attendance for a day or range: per-day counts of employees Present / Absent / Leave / Holiday / ' +
    'WeekOff / Incomplete, and the average daily Present. For ONE day it also lists each employee\'s status and ' +
    'punch times (narrow with status). Use for "how many were present yesterday", "company attendance in July", ' +
    '"who was absent on Monday". One person\'s attendance is get_attendance.',
  measure:
    'EMPLOYEE-DAYS: every current Employee-role profile gets one computed status per day (week-offs, holidays, ' +
      'joining/resign dates applied); total is the number of employees in the population.',
  input: Joi.object({
    window: windowSchema.required(),
    status: Joi.string().valid(...DAY_STATUSES).description('Single-day employee list: only this status.'),
  }),
  access: ATTENDANCE_SUMMARY_ACCESS,
  async execute({ window, status } = {}, ctx) {
    attendanceScope(ctx);
    const { from, to } = dayKeys(window);
    const spanDays = Math.round((to - from) / 86400000) + 1;
    if (spanDays > MAX_WINDOW_DAYS) {
      return { error: `Pick a window of at most ${MAX_WINDOW_DAYS} days (asked for ${spanDays}).` };
    }
    // Day keys are IST days: a UTC "today" called 00:00–05:30 IST today a future date.
    const now = (ctx?.deps?.now ?? (() => new Date()))();
    const todayKey = new Date(`${dateStrInTz(now, DEFAULT_TIMEZONE)}T00:00:00.000Z`);
    if (from > todayKey) {
      return { futureDate: true, total: 0, note: 'Attendance is only recorded for days that have already happened.' };
    }
    // Population is the Employee role — no adminId subtree (inventory bug B2).
    const raw = await attendanceDeps(ctx).aggregateOrgAttendance({ from, to, statusFilter: status });
    const out = enrichAttendanceSummary(raw);
    return {
      window,
      total: out.total,
      avgDailyPresent: out.avgDailyPresent,
      daysCounted: out.dayCount,
      perDay: out.perDay,
      ...(out.employees?.length ? { employees: out.employees } : {}),
      ...(out.ignoredUnknownStatusRecords ? { ignoredUnknownStatusRecords: out.ignoredUnknownStatusRecords } : {}),
    };
  },
  render(result) {
    if (!result || result.error || result.futureDate) return null;
    const blocks = [];
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
