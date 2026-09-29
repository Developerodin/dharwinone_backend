import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  ON_LEAVE_TODAY_ACCESS, attendanceScope, attendanceDeps, countFacts, simpleTable, isoDay,
} from './common.js';

export default defineTool({
  name: 'who_is_on_leave_today',
  domain: 'attendance',
  kind: 'read',
  description:
    'Who is on leave TODAY (off / away / out of office right now), with leave type and the span of their leave. ' +
    'Reads the attendance ledger, same as the dashboard "On leave today" widget. A zero is a real answer — do ' +
    'not go looking in leave requests for pending filings instead.',
  measure:
    'EMPLOYEES with a Leave attendance day today, within the dashboard widget\'s scope (all / your referrals / yourself).',
  input: Joi.object({}),
  access: ON_LEAVE_TODAY_ACCESS,
  async execute(_args, ctx) {
    const user = attendanceScope(ctx);
    const { scope, results } = await attendanceDeps(ctx).getEmployeesOnLeaveToday(user);
    return {
      total: results.length,
      scope,
      records: results.map((r) => ({
        name: r.name || null,
        employeeId: r.employeeId || null,
        leaveType: r.leaveType ?? null,
        from: isoDay(r.startDate),
        to: isoDay(r.endDate),
      })),
    };
  },
  render(result) {
    if (!result) return null;
    const blocks = result.records.length ? [simpleTable({
      id: 'on-leave-today',
      title: `On leave today (${result.total})`,
      columns: [['name', 'Name'], ['employeeId', 'ID', 'secondary'], ['leaveType', 'Type'], ['from', 'From'], ['to', 'To']],
      rows: result.records,
    })] : [];
    return { blocks, facts: countFacts('who_is_on_leave_today', 'on leave today', result.total) };
  },
});
