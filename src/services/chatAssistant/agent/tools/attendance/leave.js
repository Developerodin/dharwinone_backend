import Joi from 'joi';
import { buildLeaveRankingPipeline, decorateRankedRows } from '../../../leaveRanking.js';
import { leaveDatesWindowClause } from '../../../attendanceAnalytics.js';
import {
  LEAVE_STATUSES, LEAVE_TYPES, windowSchema, personSchema, dayKeys, resolvePerson, personMiss, isoDay,
} from './common.js';

export const leaveFilters = Joi.object({
  person: personSchema.description('A named person (full name, employee id like DBS10, or email). NEVER a pronoun — ' +
    'resolve it from the conversation first. Omit (with mine unset) for every request the viewer can see.'),
  mine: Joi.boolean().description('true for the signed-in user\'s OWN leave ("my leaves"). Ignored when person is set.'),
  status: Joi.string().valid(...LEAVE_STATUSES),
  leaveType: Joi.string().valid(...LEAVE_TYPES),
  dates: windowSchema.description('Leave DAYS inside this window (a request counts when any booked day falls in it).'),
}).description('Leave request filters. No person = every request the viewer can see on the Leave Requests page.');

/**
 * filters → LeaveRequest clauses (without the page scope — the service / caller ANDs that in).
 * Person is matched on the Student whose leave it is, never requestedBy (an admin may file for them).
 * Returns { clauses, window, person } or { miss } ({ error } / { notFound } / { matches }).
 */
export async function buildLeaveMatch(filters = {}, user, deps) {
  const clauses = [];
  let person = null;
  if (filters.person || filters.mine) {
    const res = await resolvePerson(filters.person, user, deps);
    const miss = personMiss(res, filters);
    if (miss) return { miss };
    ({ person } = res);
    clauses.push({ student: { $in: person.studentIds } });
  }
  const window = dayKeys(filters.dates);
  if (window) clauses.push(leaveDatesWindowClause(window)); // $elemMatch: both bounds on the SAME day
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.leaveType) clauses.push({ leaveType: filters.leaveType });
  return { clauses, window, person };
}

const personOut = (p) => (p ? { name: p.name, employeeId: p.employeeId ?? null, self: !!p.self } : null);
const nonEmpty = (clauses) => clauses.filter((c) => c && Object.keys(c).length);

async function runLeaveRanking({ filters, built, scope, deps }) {
  if (!built.window) return { error: 'Ranking by employee needs filters.dates — ask which period.' };
  const status = filters.status ?? 'approved';
  // The pipeline adds its own dates / status / leaveType match, so pass only scope + person.
  const rest = nonEmpty([scope, ...built.clauses.filter((c) => c.student)]);
  const rows = decorateRankedRows(await deps.LeaveRequest.aggregate(buildLeaveRankingPipeline({
    companyFilter: rest.length ? { $and: rest } : {},
    window: built.window,
    status,
    leaveType: filters.leaveType ?? null,
    limit: 25,
  })));
  return {
    groupBy: 'employee',
    metric: 'leave days inside the window',
    statusCounted: status,
    total: rows.length,
    groups: rows.map((r) => ({
      rank: r.rank,
      name: r.name,
      employeeId: r.employeeId ?? null,
      leaveDays: r.leaveDays,
      requestCount: r.requestCount,
      leaveTypes: r.leaveTypes,
    })),
    filtersApplied: filters,
  };
}

/** Total + status / type breakdown (or a per-employee ranking) in the Leave Requests page's scope. */
export async function runLeaveCount({ filters = {}, groupBy, user, deps }) {
  const built = await buildLeaveMatch(filters, user, deps);
  if (built.miss) return built.miss;
  const { filter: scope } = await deps.buildLeaveRequestScopeFilter(user);
  if (scope === null) {
    // No Student profile → no leave rows the page would show (never an unfiltered query).
    return { total: 0, breakdown: {}, filtersApplied: filters, person: personOut(built.person) };
  }
  if (groupBy === 'employee') return runLeaveRanking({ filters, built, scope, deps });

  const clauses = nonEmpty([scope, ...built.clauses]);
  const match = clauses.length ? { $and: clauses } : {};
  const field = groupBy === 'leaveType' ? 'leaveType' : 'status';
  const [total, grouped] = await Promise.all([
    deps.LeaveRequest.countDocuments(match),
    deps.LeaveRequest.aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]),
  ]);
  const breakdown = Object.fromEntries((field === 'status' ? LEAVE_STATUSES : LEAVE_TYPES).map((k) => [k, 0]));
  for (const g of grouped || []) if (g && g._id in breakdown) breakdown[g._id] = g.count;
  return { total, groupBy: field, breakdown, filtersApplied: filters, person: personOut(built.person) };
}

const dayMs = (dates) => (dates || []).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));

/** Rows straight from queryLeaveRequests — the Leave Requests page's own query and scope. */
export async function runLeaveList({ filters = {}, limit, user, deps }) {
  const built = await buildLeaveMatch(filters, user, deps);
  if (built.miss) return built.miss;
  // $and so the service's Object.assign(filter, scopeFilter) intersects with the person, never replaces it.
  const filter = built.clauses.length ? { $and: built.clauses } : {};
  const res = await deps.queryLeaveRequests(filter, { limit, page: 1 }, user);
  return {
    total: res?.totalResults ?? 0,
    records: (res?.results || []).map((r) => {
      const ms = dayMs(r.dates);
      return {
        id: String(r._id ?? r.id ?? ''),
        person: r.student?.user?.name ?? r.requestedBy?.name ?? null,
        leaveType: r.leaveType ?? null,
        status: r.status ?? null,
        from: ms.length ? isoDay(Math.min(...ms)) : null,
        to: ms.length ? isoDay(Math.max(...ms)) : null,
        days: ms.length,
        reviewedBy: r.reviewedBy?.name ?? null,
        requestedAt: r.createdAt ?? null,
      };
    }),
    filtersApplied: filters,
    person: personOut(built.person),
  };
}
