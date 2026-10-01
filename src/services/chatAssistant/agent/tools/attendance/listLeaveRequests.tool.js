import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { LEAVE_ACCESS, MAX_LIST_LIMIT, attendanceScope, attendanceDeps, countFacts, simpleTable } from './common.js';
import { leaveFilters, runLeaveList } from './leave.js';

export default defineTool({
  name: 'list_leave_requests',
  domain: 'attendance',
  kind: 'read',
  description:
    'List leave REQUESTS newest first: person, type, status, first/last day, number of days, reviewer, ' +
    'adminComment (the reviewer comment the Leave Requests page shows on the card; null when none was recorded). ' +
    'Use for "pending leave requests", "Saad\'s leaves in April", "my leave history", "why was this leave rejected". ' +
    'total is the full count.',
  measure:
    'Leave REQUEST records you can see on the Leave Requests page, every status unless filters.status is set.',
  input: Joi.object({
    filters: leaveFilters,
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: LEAVE_ACCESS,
  async execute({ filters, limit } = {}, ctx) {
    const user = attendanceScope(ctx);
    return runLeaveList({ filters, limit, user, deps: attendanceDeps(ctx) });
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound) return null;
    const blocks = result.records.length ? [simpleTable({
      id: 'leave-request-list',
      title: `Leave requests (${result.total})`,
      columns: [['person', 'Person'], ['leaveType', 'Type'], ['status', 'Status'], ['from', 'From'], ['to', 'To'],
        ['days', 'Days', 'secondary'], ['adminComment', 'Admin comment', 'secondary']],
      rows: result.records.map((r) => ({ ...r, days: String(r.days) })),
    })] : [];
    return { blocks, facts: countFacts('list_leave_requests', 'leave requests', result.total) };
  },
});
