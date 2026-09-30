/**
 * Shared by request_documents and remind_pending_documents: who may act, which profile they may act
 * on, and who (if anyone) the notice reaches. Everything here is read-only.
 */
import UserModel from '../../../../../../models/user.model.js';
import SageActionModel from '../../../../../../models/sageAction.model.js';
import { canRequestPreBoardingDocs } from '../../../../../../controllers/employee.controller.js';
import { toApiFilter } from '../../../../../../schemas/employees/employeeQuery.scope.js';
import { requestDocumentFromCandidate as realRequestDocumentFromCandidate } from '../../../../../employee.service.js';
import {
  notify as realNotify,
  notifyByEmail as realNotifyByEmail,
  plainTextEmailBody,
} from '../../../../../notification.service.js';
import { writeAtsAudit as realWriteAtsAudit } from '../../../../../atsAudit.service.js';
import { checkAccessRule } from '../../../../toolAccess.js';
import { STALE_MESSAGE } from '../../../sageActions.js';
import { personRecordsScope, personRecordsDeps } from '../../employees/common.js';
import { ownsProfile } from '../../ownsProfile.js';

// employee.controller.js canRequestPreBoardingDocs — the check requestDocument actually enforces. The route
// (employee.route.js canRequestDocument) also lets employees.edit in, but the controller then refuses it.
export const DOCUMENT_REQUEST_ACCESS = Object.freeze({
  anyOf: ['candidates.manage', 'employees.manage', 'pre-boarding.create', 'pre-boarding.manage'],
});
// employee.route.js canRequestDocument, checked on top: the effective gate is route AND controller.
const REQUEST_ROUTE_ACCESS = Object.freeze({ anyOf: ['candidates.manage', 'employees.edit', 'pre-boarding.create'] });

export const NO_ACCESS_MESSAGE =
  'You cannot request documents (needs candidates.manage, employees.manage, pre-boarding.create or pre-boarding.manage).';
export const MAX_DOCUMENTS = 10;
export const NOTICE_TYPE = 'onboarding_reminder';
// ats/my-applications lists the person's pending requests (employee.service getMyDocumentRequests).
export const NOTICE_LINK = '/ats/my-applications';
// Logins that can still receive a notice (user.model.js status).
const NOTIFIABLE_STATUSES = ['active', 'pending'];
export const PROFILE_FIELDS =
  'fullName email owner employeeId documentRequests.type documentRequests.label documentRequests.status documentRequests.requestedAt';
const MAX_MATCHES = 6;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const idOf = (v) => (v == null ? null : String(v._id ?? v.id ?? v));
export const lc = (s) => String(s ?? '').trim().toLowerCase();
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo, mail or notifications. */
export function documentActionDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    ...personRecordsDeps(ctx),
    User: deps.User ?? UserModel,
    SageAction: deps.SageAction ?? SageActionModel,
    requestDocumentFromCandidate: deps.requestDocumentFromCandidate ?? realRequestDocumentFromCandidate,
    notify: deps.notify ?? realNotify,
    notifyByEmail: deps.notifyByEmail ?? realNotifyByEmail,
    writeAtsAudit: deps.writeAtsAudit ?? realWriteAtsAudit,
    now: deps.now ?? (() => new Date()),
  };
}

export const documentActionScope = personRecordsScope;

/**
 * The effective check of POST /employees/documents/request/:candidateId: the route's anyOf (aliases
 * resolved, platform super user passes) AND the controller's canRequestPreBoardingDocs (raw permission
 * keys, no bypass) — whichever is narrower wins.
 */
export async function canRequestDocuments(user, deps = {}) {
  const route = await checkAccessRule(REQUEST_ROUTE_ACCESS, user, deps);
  return route.ok && canRequestPreBoardingDocs({ authContext: user?.authContext });
}

/**
 * One candidate / employee profile, only among those the Candidates / Employees page shows this viewer
 * (applyEmployeeListScope + buildEmployeeListMongoFilter, Candidate or Employee role, any employment
 * status). By profile id, exact name / email / employee id, or a partial name; an exact match wins.
 * Anything outside the scope is never read, so a refusal cannot reveal whether the person exists.
 * Note: buildEmployeeListMongoFilter repairs missing profiles for Candidate / Employee logins
 * (ensureProfilesForActiveAtsRoleUsers) — the same repair the page's own list request runs.
 */
export async function resolveVisibleProfile(person, user, deps) {
  const q = String(person || '').trim();
  const roleFilter = { ownerUserRole: 'jobSeeker', employmentStatus: 'all' };
  const apiFilter = await deps.applyEmployeeListScope(toApiFilter(roleFilter), user, user.authContext);
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const exact = new RegExp(`^${escapeRegex(q)}$`, 'i');
  const match = OBJECT_ID_RE.test(q)
    ? { _id: q }
    : { $or: [{ fullName: { $regex: escapeRegex(q), $options: 'i' } }, { email: exact }, { employeeId: exact }] };
  const rows = await deps.Employee.find({ $and: [mongoFilter, match] }).select(PROFILE_FIELDS).limit(MAX_MATCHES).lean();
  if (!rows.length) return { error: `No candidate or employee you can see matches "${q}".` };
  const exactRows = rows.filter((r) => exact.test(r.fullName || '') || exact.test(r.email || '') || exact.test(r.employeeId || ''));
  if (exactRows.length === 1) return { profile: exactRows[0] };
  if (rows.length === 1) return { profile: rows[0] };
  const names = rows.slice(0, 5).map((r) => `${r.fullName || 'Unnamed'}${r.employeeId ? ` (${r.employeeId})` : ''}`);
  return { error: `More than one person matches "${q}": ${names.join(', ')}. Which one?` };
}

/**
 * Who the notice reaches. The owner login only when the profile speaks for it (ownsProfile); otherwise
 * the login whose email is the profile's own email (what notifyByEmail looks up). A recruiter who merely
 * owns a public-apply profile is never the recipient. null = no way to notify them.
 * @returns {Promise<{ channel: 'owner'|'email', userId: string }|null>}
 */
export async function resolveRecipient(emp, deps) {
  const speaks = (await ownsProfile([emp], deps))(emp);
  let login = null;
  if (speaks) {
    login = await deps.User.findById(emp.owner).select('_id status').lean();
  } else if (emp.email) {
    login = await deps.User.findOne({ email: lc(emp.email) }).select('_id status').lean();
  }
  if (!login || !NOTIFIABLE_STATUSES.includes(login.status)) return null;
  return { channel: speaks ? 'owner' : 'email', userId: idOf(login) };
}

/** The summary line naming the channel, or why nobody will be told. */
export function recipientLine(name, recipient) {
  if (!recipient) {
    return `No way to notify ${name}: the profile has no active DharwinOne login of their own.`;
  }
  if (recipient.channel === 'owner') {
    return `Notify ${name}: in-app notice and email to their DharwinOne login.`;
  }
  return (
    `Notify ${name}: in-app notice and email to the login that uses this profile's email. The profile is held ` +
    "under another account, so the requests do not show on this person's My Applications page."
  );
}

/** Sends the one notice through the channel prepare chose. Never throws: a failed notice is reported. */
export async function sendNotice(recipient, emp, { title, message, triggeredBy }, deps) {
  const options = {
    type: NOTICE_TYPE,
    title,
    message,
    link: NOTICE_LINK,
    triggeredBy,
    email: { subject: title, text: plainTextEmailBody(message, NOTICE_LINK) },
  };
  try {
    if (recipient.channel === 'owner') await deps.notify(recipient.userId, options);
    else await deps.notifyByEmail(emp.email, options);
    return true;
  } catch {
    return false;
  }
}

export const listLabels = (labels) => labels.map((l) => `"${l}"`).join(', ');

export const pendingRequests = (emp) =>
  (emp?.documentRequests || []).map((r, index) => ({ ...r, index })).filter((r) => r.status === 'pending');

export const requesterName = (user) => String(user?.name || '').trim() || 'Your recruiter';

// atsAudit's parseAuditSource keeps an `ats/…` header as metadata.source; Sage commits have no request.
export const sageAuditReq = (ctx) => ({
  headers: { 'x-audit-source': 'ats/sage', ...(ctx?.requestId ? { 'x-request-id': String(ctx.requestId) } : {}) },
});

/**
 * Confirm check shared by both tools: re-run prepare and refuse unless it would do exactly what the
 * draft said (same profile, same recipient, same documents), not just the same target.
 */
export async function recheckByPrepare(prepare, draft, ctx) {
  const fresh = await prepare(draft.args, ctx);
  if (!fresh?.ok) return { ok: false, error: fresh?.error || STALE_MESSAGE };
  return JSON.stringify(fresh.payload) === JSON.stringify(draft.payload) ? { ok: true } : { ok: false, error: STALE_MESSAGE };
}
