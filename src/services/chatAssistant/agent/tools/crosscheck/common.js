import EmployeeModel from '../../../../../models/employee.model.js';
import UserModel from '../../../../../models/user.model.js';
import StudentModel from '../../../../../models/student.model.js';
import JobApplicationModel from '../../../../../models/jobApplication.model.js';
import MeetingModel from '../../../../../models/meeting.model.js';
import InternalMeetingModel from '../../../../../models/internalMeeting.model.js';
import OfferModel from '../../../../../models/offer.model.js';
import PlacementModel from '../../../../../models/placement.model.js';
import TaskModel from '../../../../../models/task.model.js';
import LeaveRequestModel from '../../../../../models/leaveRequest.model.js';
import JobModel from '../../../../../models/job.model.js';
import {
  buildApplicantQuery as realBuildApplicantQuery,
  aggregateApplicationsByJob as realAggregateApplicationsByJob,
} from '../../../../applicantQuery.service.js';
import {
  meetingScope as realMeetingScope,
  internalMeetingScope as realInternalMeetingScope,
} from '../../../../visibilityScope.service.js';
import { buildOfferVisibilityClause as realOfferVisibility } from '../../../../offer.service.js';
import { buildPlacementVisibilityClause as realPlacementVisibility } from '../../../../placement.service.js';
import { buildLeaveRequestScopeFilter as realLeaveScope } from '../../../../leaveRequest.service.js';
import { buildTree as realBuildTree } from '../../../../orgStructure.service.js';
import { countActiveProjectsByAssignee as realCountActiveProjects } from '../../../../projectCapacity.js';
import evaluationService from '../../../../evaluation.service.js';
import { getPositionRoster as realGetPositionRoster } from '../../../../position.service.js';
import { buildAccessibleTaskFilter as realBuildAccessibleTaskFilter } from '../../../taskAccess.js';
import { resolveJobVisibilityFilter as realJobVisibility } from '../../../queryPlanner/entities/jobRank.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { userIsAdmin } from '../../../../../utils/roleHelpers.js';
import { dateStrInTz, addDaysToDateStr, dayOfWeekOfDateStr } from '../../../../../utils/zonedTime.js';
import { runTool as realRunTool } from '../../compose.js';
import { runWithTimeout, TOOL_TIMEOUT } from '../../runWithTimeout.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { personRecordsDeps, dayWindowBounds } from '../employees/common.js';
import { hiringDeps } from '../hiring/common.js';

/**
 * Every id set is capped: more than SET_CAP ids → truncated, and an answer built on it says "at least".
 * ponytail: 5000 ids per side keeps each set a single bounded read; past that, move the check into one
 * aggregate with $lookup on the other side's collection.
 */
export const SET_CAP = 5000;
export const QUERY_MAX_MS = 8000;
export const ROW_LIMIT = 20;
export const MAX_ROW_LIMIT = 50;
export const SECTION_TIMEOUT_MS = 12000;
export const NOT_CAPTURED = 'not captured in DharwinOne';

export function crosscheckScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) throw new Error('cross-check tools need an authenticated user with an id');
  return ctx.user;
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function crosscheckDeps(ctx) {
  const d = ctx?.deps || {};
  const people = personRecordsDeps(ctx);
  return {
    Employee: d.Employee ?? EmployeeModel,
    User: d.User ?? UserModel,
    Student: d.Student ?? StudentModel,
    JobApplication: d.JobApplication ?? JobApplicationModel,
    Meeting: d.Meeting ?? MeetingModel,
    InternalMeeting: d.InternalMeeting ?? InternalMeetingModel,
    Offer: d.Offer ?? OfferModel,
    Placement: d.Placement ?? PlacementModel,
    Task: d.Task ?? TaskModel,
    LeaveRequest: d.LeaveRequest ?? LeaveRequestModel,
    Job: d.Job ?? JobModel,
    buildApplicantQuery: d.buildApplicantQuery ?? realBuildApplicantQuery,
    aggregateApplicationsByJob: d.aggregateApplicationsByJob ?? realAggregateApplicationsByJob,
    meetingScope: d.meetingScope ?? realMeetingScope,
    internalMeetingScope: d.internalMeetingScope ?? realInternalMeetingScope,
    buildOfferVisibilityClause: d.buildOfferVisibilityClause ?? realOfferVisibility,
    buildPlacementVisibilityClause: d.buildPlacementVisibilityClause ?? realPlacementVisibility,
    buildLeaveRequestScopeFilter: d.buildLeaveRequestScopeFilter ?? realLeaveScope,
    buildTree: d.buildTree ?? realBuildTree,
    countActiveProjects: d.countActiveProjects ?? realCountActiveProjects,
    getEvaluationData: d.getEvaluationData ?? evaluationService.getEvaluationData,
    getPositionRoster: d.getPositionRoster ?? realGetPositionRoster,
    buildAccessibleTaskFilter: d.buildAccessibleTaskFilter ?? realBuildAccessibleTaskFilter,
    resolveJobVisibilityFilter: d.resolveJobVisibilityFilter ?? realJobVisibility,
    canSeeAllReferralLeads: d.canSeeAllReferralLeads ?? hiringDeps(ctx).canSeeAllReferralLeads,
    authorizeEmployeeQuery: people.authorizeEmployeeQuery,
    applyEmployeeListScope: people.applyEmployeeListScope,
    buildEmployeeListMongoFilter: people.buildEmployeeListMongoFilter,
    isAdmin: d.isAdmin ?? userIsAdmin,
    runTool: d.runTool ?? realRunTool,
    now: d.now ?? (() => new Date()),
  };
}

export const idOf = (v) => (v == null ? null : String(v?._id ?? v?.id ?? v));
export const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
export const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function allowed(rule, user, deps) {
  return (await checkAccessRule(rule, user, deps)).ok;
}

/** Page visibility clause (offer / placement services) → a Mongo clause; null = the viewer sees none. */
export function visibilityToMongo(clause) {
  if (!clause || clause.blocked) return null;
  if (clause.unrestricted) return {};
  if (clause.orClause) return clause.orClause;
  if (clause.createdBy) return { createdBy: clause.createdBy };
  return null;
}

/** Id-only bounded read: SET_CAP + 1 rows tells truncation apart from exactly SET_CAP. */
export async function cappedRows(query) {
  const rows = await query.limit(SET_CAP + 1).maxTimeMS(QUERY_MAX_MS).lean();
  return { rows: rows.slice(0, SET_CAP), truncated: rows.length > SET_CAP };
}

// ─── Set results ────────────────────────────────────────────────────────────
// ok:        { status:'ok', label, kind, ids:Set, info:Map, total, truncated, unmapped, partialScope?, notes? }
// otherwise: { status:'restricted'|'notCaptured'|'error'|'timeout', label, reason? }

export function okSet(label, kind, info, extra = {}) {
  const ids = new Set(info.keys());
  return {
    status: 'ok', label, kind, ids, info, total: ids.size,
    truncated: !!extra.truncated, unmapped: extra.unmapped ?? 0,
    ...(extra.partialScope ? { partialScope: extra.partialScope } : {}),
    ...(extra.notes?.length ? { notes: extra.notes } : {}),
  };
}

export const restrictedSet = (label, reason) => ({ status: 'restricted', label, ...(reason ? { reason } : {}) });
export const notCapturedSet = (label, reason) => ({ status: 'notCaptured', label, reason });

/** Runs one set builder with its own timeout; a throw becomes an error section, never a thrown tool. */
export async function guardSet(label, fn, timeoutMs = SECTION_TIMEOUT_MS) {
  try {
    return await runWithTimeout(fn, timeoutMs);
  } catch (err) {
    if (err?.code === TOOL_TIMEOUT) return { status: 'timeout', label };
    return { status: 'error', label, reason: err?.message || String(err) };
  }
}

/** runTool status → a set status for a composed section (ok handled by the caller). */
export function composedFailure(label, res) {
  if (res.status === 'restricted') return restrictedSet(label);
  if (res.status === 'timeout') return { status: 'timeout', label };
  if (res.status === 'ok' && res.result?.error) return { status: 'error', label, reason: res.result.error };
  return { status: 'error', label, reason: res.error || `section status ${res.status}` };
}

// ─── IST days ───────────────────────────────────────────────────────────────

export const todayIst = (now) => dateStrInTz(new Date(now), DEFAULT_TIMEZONE);
export const istDayOf = (d) => (d ? dateStrInTz(new Date(d), DEFAULT_TIMEZONE) : null);

/** Whole IST days → { from: Date, to: Date } instants (dayWindowBounds). */
export function istBounds(from, to = from) {
  const b = dayWindowBounds({ from, to });
  return { from: new Date(b.from), to: new Date(b.to) };
}

/** Next Monday–Sunday calendar week in IST. */
export function nextWeek(today) {
  const dow = dayOfWeekOfDateStr(today);
  const from = addDaysToDateStr(today, ((8 - dow) % 7) || 7);
  return { from, to: addDaysToDateStr(from, 6) };
}

const isWeekend = (day) => [0, 6].includes(dayOfWeekOfDateStr(day));

/**
 * The first of the last N business days before today (Mon–Fri IST, minus `holidays` day strings).
 * "Unchanged for N business days" = no change on any of those days or today, i.e. last change before
 * this day's IST midnight.
 */
export function businessDaysBack(today, n, holidays = new Set()) {
  let day = today;
  let counted = 0;
  while (counted < n) {
    day = addDaysToDateStr(day, -1);
    if (!isWeekend(day) && !holidays.has(day)) counted += 1;
  }
  return day;
}

/** list_holidays rows → the set of IST day strings they cover (endDate inclusive). */
export function holidayDays(holidays = []) {
  const out = new Set();
  for (const h of holidays) {
    const start = istDayOf(h.date);
    if (!start) continue;
    const end = istDayOf(h.endDate) || start;
    for (let d = start; d <= end; d = addDaysToDateStr(d, 1)) out.add(d);
  }
  return out;
}

export { addDaysToDateStr, DEFAULT_TIMEZONE };
