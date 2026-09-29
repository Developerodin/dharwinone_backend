import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { ATTENDANCE_STATUSES } from '../../../../../models/attendance.model.js';
import {
  ATTENDANCE_ACCESS, MAX_LIST_LIMIT, windowSchema, personSchema, attendanceScope, attendanceDeps, dayKeys,
  resolvePerson, personMiss, canViewOthersAttendance, simpleTable, isoDay,
} from './common.js';
import { formatPunchIST } from '../../../attendanceAggregator.js';

const FETCH_CAP = 200; // rows read for the status breakdown; the service caps at 500
const DEFAULT_DAYS = 30;

function defaultWindow(now = new Date()) {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (DEFAULT_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

export default defineTool({
  name: 'get_attendance',
  domain: 'attendance',
  kind: 'read',
  description:
    'One person\'s attendance rows (date, punch in/out in IST, hours, status, leave type) for a window, with a ' +
    'per-status day count. person omitted = the signed-in user ("my attendance", "when did I punch in"). ' +
    'window defaults to the last 30 days. Company-wide present/absent counts are get_attendance_summary.',
  measure:
    'ATTENDANCE RECORDS (punch / leave / holiday rows) for one person inside the window — the same rows the ' +
      'Attendance page lists; days with no row are not counted.',
  input: Joi.object({
    person: personSchema,
    window: windowSchema,
    status: Joi.string().valid(...ATTENDANCE_STATUSES).description('Only rows with this status.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(31),
  }),
  access: ATTENDANCE_ACCESS,
  async execute({ person, window, status, limit = 31 } = {}, ctx) {
    const user = attendanceScope(ctx);
    const deps = attendanceDeps(ctx);
    const res = await resolvePerson(person, user, deps, { canName: canViewOthersAttendance });
    const miss = personMiss(res, { person });
    if (miss) return miss;
    const who = res.person;
    const win = window || defaultWindow();
    dayKeys(win); // validates (shared dayRange) — the service takes the day strings itself
    const query = { startDate: win.from, endDate: win.to, limit: FETCH_CAP, page: 1 };
    // Same source choice as GET /attendance/candidate/:id: the Student profile when there is one, else user rows.
    const page = who.studentIds.length
      ? await deps.listByStudent(String(who.studentIds[0]), query)
      : await deps.listByUser(who.userId, query);
    const rows = (page?.results || []).filter((r) => !status || r.status === status);
    const statusBreakdown = {};
    for (const r of rows) statusBreakdown[r.status || 'Unknown'] = (statusBreakdown[r.status || 'Unknown'] || 0) + 1;
    return {
      person: { name: who.name, employeeId: who.employeeId ?? null, self: !!who.self },
      window: win,
      total: status ? rows.length : (page?.totalResults ?? rows.length),
      statusBreakdown,
      ...(page?.totalResults > FETCH_CAP ? { breakdownCoversFirst: FETCH_CAP } : {}),
      records: rows.slice(0, limit).map((r) => ({
        date: isoDay(r.date),
        status: r.status ?? null,
        leaveType: r.leaveType ?? null,
        punchIn: r.punchIn ? formatPunchIST(new Date(r.punchIn)) : null,
        punchOut: r.punchOut ? formatPunchIST(new Date(r.punchOut)) : null,
        hours: r.duration ? +(Number(r.duration) / 3600000).toFixed(2) : null,
        notes: r.notes ?? null,
      })),
    };
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound) return null;
    const blocks = result.records.length ? [simpleTable({
      id: 'attendance-list',
      title: `Attendance — ${result.person.self ? 'you' : result.person.name} (${result.window.from} to ${result.window.to})`,
      columns: [['date', 'Date'], ['status', 'Status'], ['punchIn', 'In'], ['punchOut', 'Out'], ['hours', 'Hours', 'secondary'],
        ['leaveType', 'Leave type', 'secondary']],
      rows: result.records.map((r) => ({ ...r, hours: r.hours == null ? null : String(r.hours) })),
    })] : [];
    return { blocks };
  },
});
