import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { LEAVE_ACCESS, attendanceScope, attendanceDeps, countFacts, simpleTable } from './common.js';
import { leaveFilters, runLeaveCount } from './leave.js';

export default defineTool({
  name: 'count_leave_requests',
  domain: 'attendance',
  kind: 'read',
  description:
    'Count leave REQUESTS (filings with an approval status), with a breakdown by status (default) or leaveType. ' +
    'groupBy "employee" ranks people by leave DAYS inside filters.dates ("who took the most leave this month") — ' +
    'it needs filters.dates and counts approved leave unless filters.status is set. ' +
    'Not for "who is on leave today" (who_is_on_leave_today).',
  measure:
    'Leave REQUEST records you can see on the Leave Requests page (every status unless filters.status is set); ' +
      'groupBy employee instead counts leave DAYS per person inside the window.',
  input: Joi.object({
    filters: leaveFilters,
    groupBy: Joi.string().valid('status', 'leaveType', 'employee').default('status'),
  }),
  access: LEAVE_ACCESS,
  async execute({ filters, groupBy } = {}, ctx) {
    const user = attendanceScope(ctx);
    return runLeaveCount({ filters, groupBy, user, deps: attendanceDeps(ctx) });
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound) return null;
    if (result.groupBy === 'employee') {
      return {
        blocks: result.groups.length ? [simpleTable({
          id: 'leave-ranking',
          title: `Leave days by person (${result.statusCounted})`,
          columns: [['rank', '#'], ['name', 'Name'], ['employeeId', 'ID', 'secondary'], ['leaveDays', 'Leave days'],
            ['requestCount', 'Requests', 'secondary']],
          rows: result.groups.map((g) => ({
            ...g, rank: String(g.rank), leaveDays: String(g.leaveDays), requestCount: String(g.requestCount),
          })),
        })] : [],
      };
    }
    return { blocks: [], facts: countFacts('count_leave_requests', 'leave requests', result.total) };
  },
});
