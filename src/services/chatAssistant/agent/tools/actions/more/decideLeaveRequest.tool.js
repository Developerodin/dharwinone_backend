import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import LeaveRequestModel from '../../../../../../models/leaveRequest.model.js';
import EmployeeModel from '../../../../../../models/employee.model.js';
import StudentModel from '../../../../../../models/student.model.js';
import {
  buildLeaveRequestScopeFilter as realBuildLeaveRequestScopeFilter,
  approveLeaveRequest as realApproveLeaveRequest,
  rejectLeaveRequest as realRejectLeaveRequest,
} from '../../../../../leaveRequest.service.js';
import { userIsAdminOrAgent as realIsAdminOrAgent } from '../../../../../../utils/roleHelpers.js';
import { HEX_ID_RE, actorOf, escapeRegex, recheckSameDraft } from './common.js';

// leaveRequest.route.js PATCH /:requestId/approve and /reject — requirePermissions('students.manage').
// approveLeaveRequest / rejectLeaveRequest also require Administrator or Agent (userIsAdminOrAgent).
export const LEAVE_DECISION_ACCESS = Object.freeze({ allOf: ['students.manage'] });

const NOT_ADMIN = 'Only an Administrator or Agent can approve or reject leave requests.';
const LEAVE_POPULATE = [
  { path: 'student', select: 'user', populate: { path: 'user', select: 'name email' } },
];

function leaveDeps(ctx) {
  const d = ctx?.deps || {};
  return {
    LeaveRequest: d.LeaveRequest ?? LeaveRequestModel,
    Employee: d.Employee ?? EmployeeModel,
    Student: d.Student ?? StudentModel,
    buildLeaveRequestScopeFilter: d.buildLeaveRequestScopeFilter ?? realBuildLeaveRequestScopeFilter,
    approveLeaveRequest: d.approveLeaveRequest ?? realApproveLeaveRequest,
    rejectLeaveRequest: d.rejectLeaveRequest ?? realRejectLeaveRequest,
    isAdminOrAgent: d.isAdminOrAgent ?? realIsAdminOrAgent,
  };
}

const plain = (q) => (q && typeof q.lean === 'function' ? q.lean() : q);

const leaveDoc = (q) => (q && typeof q.populate === 'function' ? q.populate(LEAVE_POPULATE).lean() : q);

function dayKey(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function personOf(row) {
  const name = row?.student?.user?.name?.trim() || null;
  const email = row?.studentEmail || row?.student?.user?.email || null;
  return { name, email };
}

function noticeCopy(decision, comment) {
  if (decision === 'approve') {
    return {
      title: 'Leave request approved',
      message: comment
        ? `Your leave request has been approved. Comment: ${comment}`
        : 'Your leave request has been approved.',
    };
  }
  return {
    title: 'Leave request rejected',
    message: comment
      ? `Your leave request was not approved. Comment: ${comment}`
      : 'Your leave request was not approved.',
  };
}

async function resolveById(requestId, scope, deps) {
  const clause = { _id: requestId };
  const filter = scope && Object.keys(scope).length ? { $and: [scope, clause] } : clause;
  const row = await leaveDoc(deps.LeaveRequest.findOne(filter));
  if (row) return { row };
  const exists = await deps.LeaveRequest.exists({ _id: requestId });
  return { error: exists ? '1 leave request is outside your scope.' : 'No leave request found with that id.' };
}

async function resolveByName(name, scope, deps) {
  const exact = new RegExp(`^${escapeRegex(name)}$`, 'i');
  const loose = new RegExp(escapeRegex(name), 'i');
  const employees = await plain(
    deps.Employee.find({ $or: [{ fullName: loose }, { employeeId: exact }, { email: exact }] })
      .select('fullName employeeId owner').limit(8),
  ) || [];
  const exactRows = employees.filter((e) => exact.test(e.fullName || '') || exact.test(e.employeeId || '') || exact.test(e.email || ''));
  const pool = exactRows.length ? exactRows : employees;
  if (!pool.length) return { error: `No employee matches "${name}".` };
  if (pool.length > 1) {
    const shown = pool.slice(0, 5).map((e) => (e.employeeId ? `${e.fullName} (${e.employeeId})` : e.fullName));
    return { error: `${pool.length} people match "${name}". Say which one: ${shown.join('; ')}.` };
  }
  const owner = pool[0].owner;
  if (!owner) return { error: `${pool[0].fullName || name} has no DharwinOne login, so they have no leave requests.` };
  const students = await plain(deps.Student.find({ user: owner }).select('_id')) || [];
  const studentIds = students.map((s) => s._id);
  if (!studentIds.length) return { error: `No pending leave request for ${pool[0].fullName || name}.` };

  const pendingClause = { student: { $in: studentIds }, status: 'pending' };
  const filter = scope && Object.keys(scope).length ? { $and: [scope, pendingClause] } : pendingClause;
  const pending = await leaveDoc(deps.LeaveRequest.find(filter)) || [];
  if (pending.length === 1) return { row: pending[0] };
  if (pending.length > 1) {
    const shown = pending.slice(0, 5).map((r) => {
      const days = (r.dates || []).map(dayKey).filter(Boolean).join(', ') || 'no dates';
      return `${r.leaveType || 'leave'} on ${days} (id ${r._id ?? r.id})`;
    });
    return { error: `${pending.length} pending leave requests match "${name}". Say which one by id: ${shown.join('; ')}.` };
  }
  const hidden = await deps.LeaveRequest.exists({ student: { $in: studentIds }, status: 'pending' });
  if (hidden) return { error: '1 leave request is outside your scope.' };
  return { error: `No pending leave request for ${pool[0].fullName || name}.` };
}

async function prepare({ request, decision, comment }, ctx) {
  const { user } = actorOf(ctx);
  const deps = leaveDeps(ctx);
  if (!(await deps.isAdminOrAgent(user))) return { ok: false, error: NOT_ADMIN };

  const { filter: scope } = await deps.buildLeaveRequestScopeFilter(user);
  if (scope === null) return { ok: false, error: 'No leave requests are visible to you.' };

  const found = HEX_ID_RE.test(String(request).trim())
    ? await resolveById(String(request).trim(), scope, deps)
    : await resolveByName(String(request).trim(), scope, deps);
  if (found.error) return { ok: false, error: found.error };

  const row = found.row;
  if (row.status !== 'pending') {
    return { ok: false, error: `This leave request is already ${row.status || 'not pending'}, so it cannot be ${decision === 'approve' ? 'approved' : 'rejected'}.` };
  }

  const { name, email } = personOf(row);
  const who = name || email || null;
  const days = (row.dates || []).map(dayKey).filter(Boolean);
  const type = row.leaveType || null;
  const verb = decision === 'approve' ? 'Approve' : 'Reject';
  const notice = noticeCopy(decision, comment);
  const lines = [
    `${verb} this leave request.`,
    name ? `Person: ${name}.` : 'Person: not recorded.',
    days.length ? `Dates: ${days.join(', ')}.` : 'Dates: not recorded.',
    type ? `Type: ${type}.` : 'Type: not recorded.',
    `Decision: ${decision}.`,
    comment ? `Reviewer comment: "${comment}".` : 'No reviewer comment.',
  ];
  if (email) {
    lines.push(
      `${who} (${email}) will get an in-app notification and an email: "${notice.title}" — "${notice.message}".`,
    );
  } else {
    lines.push('Nobody to notify — this request has no student email on record.');
  }

  const requestId = String(row._id ?? row.id);
  return {
    ok: true,
    summary: {
      title: `${verb} ${who || 'this person'}'s ${type || ''} leave`.replace(/\s+/g, ' ').trim(),
      lines,
      targetCount: 1,
      targets: [{ id: requestId, name: who || 'Leave request' }],
      confirmLabel: `${verb} leave`,
    },
    payload: { requestId },
  };
}

async function commit(draft, ctx) {
  const { user } = actorOf(ctx);
  const deps = leaveDeps(ctx);
  if (!(await deps.isAdminOrAgent(user))) return { ok: false, message: NOT_ADMIN };
  const decision = draft.args?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, message: 'Decision must be approve or reject.' };
  }
  const { requestId } = draft.payload;
  const { filter: scope } = await deps.buildLeaveRequestScopeFilter(user);
  if (scope === null) return { ok: false, message: 'No leave requests are visible to you.' };
  const clause = { _id: requestId };
  const filter = scope && Object.keys(scope).length ? { $and: [scope, clause] } : clause;
  const row = await leaveDoc(deps.LeaveRequest.findOne(filter));
  if (!row) {
    const exists = await deps.LeaveRequest.exists({ _id: requestId });
    return { ok: false, message: exists ? 'This leave request is outside your scope.' : 'Leave request not found.' };
  }
  if (row.status !== 'pending') {
    return {
      ok: true,
      message: `Already ${row.status} — nothing changed.`,
      details: { skipped: true, status: row.status },
    };
  }

  const comment = draft.args?.comment || null;
  const run = decision === 'approve' ? deps.approveLeaveRequest : deps.rejectLeaveRequest;
  try {
    await run(requestId, comment, user);
  } catch (err) {
    if (/Current status is/i.test(err?.message || '')) {
      return { ok: true, message: 'Already decided — nothing changed.', details: { skipped: true } };
    }
    return { ok: false, message: err?.message || 'Could not update the leave request.' };
  }
  const verb = decision === 'approve' ? 'Approved' : 'Rejected';
  return { ok: true, message: `${verb} the leave request.`, details: { requestId, decision } };
}

export default defineTool({
  name: 'decide_leave_request',
  domain: 'actions',
  kind: 'write',
  description:
    'Draft approving or rejecting ONE pending leave request (Leave Requests page Approve / Reject). Only ' +
    'drafts: the user must press Confirm. Refuses a request that is not pending. Use only when the user ' +
    'asks to approve or reject a leave request. A question about leave is list_leave_requests or ' +
    'count_leave_requests, not this.',
  input: Joi.object({
    request: Joi.string().trim().min(1).max(200).required()
      .description('Leave request id from list_leave_requests, or the person\'s name when they have one pending request.'),
    decision: Joi.string().valid('approve', 'reject').required()
      .description('approve or reject.'),
    comment: Joi.string().trim().min(1).max(1000)
      .description('Optional reviewer comment. Saved on the request and included in the notice to the person.'),
  }),
  access: LEAVE_DECISION_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: recheckSameDraft(prepare),
  commit,
});
