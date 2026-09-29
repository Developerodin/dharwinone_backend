import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  BACKDATED_ACCESS, LEAVE_STATUSES, MAX_LIST_LIMIT, windowSchema, attendanceScope, attendanceDeps, dayKeys,
  resolvePerson, personMiss, countFacts, simpleTable, isoDay,
} from './common.js';

const STATUSES = LEAVE_STATUSES; // same four as BackdatedAttendanceRequest.status

/**
 * Filter clauses for queryBackdatedAttendanceRequests. Wrapped in $and so the service's own
 * non-reviewer `filter.$or = <own rows>` intersects with them instead of being overwritten — and we
 * never set a bare `filter.student`, which makes the service skip its ownership scope.
 */
function clausesFor(person, window, status) {
  const clauses = [];
  if (person) clauses.push({ $or: [{ user: person.userId }, { student: { $in: person.studentIds } }] });
  if (window) clauses.push({ attendanceEntries: { $elemMatch: { date: { $gte: window.from, $lte: window.to } } } });
  if (status) clauses.push({ status });
  return clauses.length ? { $and: clauses } : {};
}

export default defineTool({
  name: 'list_backdated_requests',
  domain: 'attendance',
  kind: 'read',
  description:
    'List backdated attendance requests (attendance corrections / missed-punch requests), newest first, with a ' +
    'per-status breakdown. Use for "pending attendance corrections", "DBS10\'s missed punch requests", ' +
    '"my backdated requests". filters.dates matches the DAYS being corrected, not the filing date.',
  measure:
    'Backdated attendance REQUEST records you can see on the Backdated Attendance page (reviewers: all; ' +
      'everyone else: their own), every status unless filters.status is set.',
  input: Joi.object({
    filters: Joi.object({
      person: Joi.string().min(1).description('A named person (name, employee id, or email). NEVER a pronoun.'),
      mine: Joi.boolean().description('true for the signed-in user\'s own requests. Ignored when person is set.'),
      status: Joi.string().valid(...STATUSES),
      dates: windowSchema,
    }),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: BACKDATED_ACCESS,
  async execute({ filters = {}, limit } = {}, ctx) {
    const user = attendanceScope(ctx);
    const deps = attendanceDeps(ctx);
    let person = null;
    if (filters.person || filters.mine) {
      const res = await resolvePerson(filters.person, user, deps);
      const miss = personMiss(res, filters);
      if (miss) return miss;
      ({ person } = res);
    }
    const window = dayKeys(filters.dates);
    const query = (status, lim) => deps.queryBackdatedAttendanceRequests(
      clausesFor(person, window, status), { limit: lim, page: 1 }, user,
    );
    const [res, ...perStatus] = await Promise.all([
      query(filters.status, limit),
      ...(filters.status ? [] : STATUSES.map((s) => query(s, 1))),
    ]);
    const breakdown = filters.status
      ? { [filters.status]: res?.totalResults ?? 0 }
      : Object.fromEntries(STATUSES.map((s, i) => [s, perStatus[i]?.totalResults ?? 0]));
    return {
      total: res?.totalResults ?? 0,
      breakdown,
      records: (res?.results || []).map((r) => {
        const days = (r.attendanceEntries || []).map((e) => isoDay(e.date)).filter(Boolean).sort();
        return {
          id: String(r._id ?? r.id ?? ''),
          person: r.student?.user?.name ?? r.user?.name ?? r.requestedBy?.name ?? null,
          status: r.status ?? null,
          days: days.length,
          from: days[0] ?? null,
          to: days[days.length - 1] ?? null,
          reviewedBy: r.reviewedBy?.name ?? null,
          requestedAt: r.createdAt ?? null,
        };
      }),
      filtersApplied: filters,
      person: person ? { name: person.name, employeeId: person.employeeId ?? null, self: !!person.self } : null,
    };
  },
  render(result) {
    if (!result || result.error || result.matches || result.notFound) return null;
    const blocks = result.records.length ? [simpleTable({
      id: 'backdated-request-list',
      title: `Backdated attendance requests (${result.total})`,
      columns: [['person', 'Person'], ['status', 'Status'], ['from', 'From'], ['to', 'To'], ['days', 'Days', 'secondary']],
      rows: result.records.map((r) => ({ ...r, days: String(r.days) })),
    })] : [];
    return { blocks, facts: countFacts('list_backdated_requests', 'backdated requests', result.total) };
  },
});
