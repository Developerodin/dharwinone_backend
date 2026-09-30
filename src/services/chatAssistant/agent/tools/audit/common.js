import Joi from 'joi';
import config from '../../../../../config/config.js';
import { ActivityActions, EntityTypes } from '../../../../../config/activityLog.js';
import ImpersonationModel from '../../../../../models/impersonation.model.js';
import UserModel from '../../../../../models/user.model.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import { escapeRegex } from '../../../../../utils/courseSearch.util.js';
import { normalizeChangesArray } from '../../../../../utils/atsAudit.helpers.js';
import requireActivityLogsListAccess from '../../../../../middlewares/requireActivityLogsListAccess.js';
import { resolveActivityLogListFilter as realResolveListFilter } from '../../../../../controllers/activityLog.controller.js';
import { queryActivityLogs as realQueryActivityLogs } from '../../../../activityLog.service.js';
import { queryUsers as realQueryUsers } from '../../../../user.service.js';
import {
  viewerSeesHiddenUsers as realViewerSeesHiddenUsers,
  getDirectoryHiddenUserIds as realGetDirectoryHiddenUserIds,
} from '../../../../../utils/platformAccess.util.js';

export const MAX_LIST_LIMIT = 50;
export const DEFAULT_LIST_LIMIT = 20;
export const NOT_CAPTURED = 'not captured in DharwinOne';

// GET /activity-logs: requireActivityLogsListAccess gates the page, resolveActivityLogListFilter grades
// it (view = own rows, create+edit = own rows with filters, delete/manage = everyone). Both run in execute.
export const ACTIVITY_ACCESS = Object.freeze({
  note: 'requireActivityLogsListAccess + resolveActivityLogListFilter (own / own-with-filters / all)',
});
// POST /auth/impersonate: requireAdministratorOrPermission('users.impersonate', ['Administrator']).
export const IMPERSONATION_ACCESS = Object.freeze({ anyOf: ['users.impersonate'], adminByName: true });

export const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked by dayWindowBounds

/** Fail closed without a user id: the activity filter would otherwise fall back to "own" with uid 'undefined'. */
export function auditScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('audit tools need an authenticated user with an id');
  }
  return ctx.user;
}

export function auditDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    activityGate: deps.activityGate ?? requireActivityLogsListAccess,
    resolveActivityLogListFilter: deps.resolveActivityLogListFilter ?? realResolveListFilter,
    isDesignatedSuperadminEmail: deps.isDesignatedSuperadminEmail ?? ((email) => config.isDesignatedSuperadminEmail(email)),
    queryActivityLogs: deps.queryActivityLogs ?? realQueryActivityLogs,
    queryUsers: deps.queryUsers ?? realQueryUsers,
    Impersonation: deps.Impersonation ?? ImpersonationModel,
    User: deps.User ?? UserModel,
    Employee: deps.Employee ?? EmployeeModel,
    viewerSeesHiddenUsers: deps.viewerSeesHiddenUsers ?? realViewerSeesHiddenUsers,
    getDirectoryHiddenUserIds: deps.getDirectoryHiddenUserIds ?? realGetDirectoryHiddenUserIds,
  };
}

/**
 * Runs the page's own Express gate against the viewer; true when it calls next() with no error.
 * req carries only what the gate reads (user, authContext — auth.js mirrors the latter onto req.user);
 * a throw, sync or async, is a refusal.
 */
export function passesGate(gate, user) {
  return new Promise((resolve) => {
    try {
      Promise.resolve(gate({ user, authContext: user.authContext }, null, (err) => resolve(!err))).catch(() => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * The Activity Logs tier, from the page's own resolveActivityLogListFilter: an empty query comes back
 * pinned to the viewer's id unless they see everyone (designated email, platform super, delete/manage).
 */
export function activityTier(user, deps) {
  const uid = String(user._id ?? user.id);
  const resolve = (query) => deps.resolveActivityLogListFilter({
    query,
    permissions: user.authContext?.permissions,
    isDesignated: deps.isDesignatedSuperadminEmail(user.email),
    isPlatformSuperUser: !!user.platformSuperUser,
    uid,
  });
  return { uid, resolve, seesEveryone: !('actor' in resolve({})) };
}

// Same buckets and order as the Activity Logs page's grouped Action filter
// (frontend shared/lib/activity-log-catalog.ts ACTION_GROUP_RULES) — keep the two in sync.
const ACTION_GROUP_RULES = [
  { label: 'Employee', test: (k) => k.startsWith('candidate.') || k.startsWith('employee.') },
  {
    label: 'Jobs & hiring',
    test: (k) =>
      ['job.', 'jobApplication.', 'interview.', 'offer.', 'placement.', 'externalJob.'].some((p) => k.startsWith(p)),
  },
  { label: 'Referrals', test: (k) => k.startsWith('referral') },
  { label: 'Support tickets', test: (k) => k.startsWith('ticket.') },
  { label: 'Organization', test: (k) => k.startsWith('org') || k.startsWith('department.') },
  {
    label: 'Training',
    test: (k) => ['student.', 'mentor.', 'category.', 'certificate.'].some((p) => k.startsWith(p)),
  },
  { label: 'Attendance', test: (k) => k.startsWith('attendance.') },
  {
    label: 'Users & roles',
    test: (k) => ['role.', 'user.', 'impersonation.', 'supportCamera.'].some((p) => k.startsWith(p)),
  },
  {
    label: 'System & settings',
    test: (k) => k.startsWith('settings.') || k.startsWith('phoneNumber.') || k === 'contact.lookup',
  },
];

export const ACTION_GROUPS = ACTION_GROUP_RULES.map((g) => g.label);
export const actionGroupOf = (action) => ACTION_GROUP_RULES.find((g) => g.test(String(action || '')))?.label ?? 'Other';
export const actionsInGroup = (label) => Object.values(ActivityActions).filter((a) => actionGroupOf(a) === label);

export const TARGET_TYPES = [...new Set(Object.values(EntityTypes))];
// Person rows are stored as "Candidate" (before the rename) or "Employee" (after); the page offers one entry.
const PERSON_TYPES = new Set(['Candidate', 'Employee']);

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const PERSON_TYPE_LIST = 'Candidate,Employee';
const NAME_MATCH_CAP = 500; // same cap and timeout as the service's own name lookups
const NAME_LOOKUP_TIMEOUT_MS = 1500;

/**
 * targetType/target → the page's entityType/entityId. A person target (id or name) matches both
 * stored spellings; a person NAME is turned into ids afterwards by resolvePersonTarget.
 */
export function entityQuery(targetType, target) {
  if (!targetType) {
    if (target) throw new Error('target needs targetType (e.g. "User", "Employee", "Job", "Role").');
    return {};
  }
  if (!PERSON_TYPES.has(targetType)) return { entityType: targetType, ...(target ? { entityId: target } : {}) };
  return { entityType: PERSON_TYPE_LIST, ...(target ? { entityId: target } : {}) };
}

/**
 * A person name left on the RESOLVED filter → Employee ids, the same starts-with fullName lookup the
 * service runs (Candidate and Employee rows both point at Employee ids). The service resolves a name
 * for ONE entityType only and a comma list has no resolver, so the ids ride on $or, which
 * buildActivityLogMongoFilter passes through untouched (it only ever writes $and). No match → a clause
 * matching nothing, never an unfiltered list. A filter whose entityId the viewer's tier dropped comes
 * back as is. Ceiling: the first 500 name matches.
 */
export async function resolvePersonTarget(filter, deps) {
  const name = filter.entityId;
  if (filter.entityType !== PERSON_TYPE_LIST || typeof name !== 'string' || OBJECT_ID_RE.test(name)) return filter;
  const re = new RegExp(`^${escapeRegex(name.trim())}`, 'i');
  const docs = await deps.Employee.find({ fullName: re })
    .select('_id')
    .limit(NAME_MATCH_CAP)
    .maxTimeMS(NAME_LOOKUP_TIMEOUT_MS)
    .lean();
  const out = { ...filter, $or: [{ entityId: { $in: docs.map((d) => String(d._id)) } }] };
  delete out.entityId;
  return out;
}

// Values never returned (field named, value hidden): pay, credentials, identity documents and contact
// details. sanitizeMetadata strips such TOP-level keys on write, but not field names inside
// metadata.changes, which carry offer pay (gross, hra, base…) and employee PII (sevisId,
// eadCardNumber, supervisorContact…). Substrings for words that cannot sit inside an innocent name;
// whole camelCase words for short ones ("pan" is inside "company", "pay" inside "display").
const SENSITIVE_SUBSTRING_RE =
  /salary|compensation|ctc|payroll|payslip|stipend|allowance|bonus|wage|password|passcode|token|secret|credential|bank|account|iban|ifsc|aadha|passport|sevis|ssn|nationalid|creditcard|signature/i;
const SENSITIVE_WORDS = new Set([
  'pay', 'gross', 'net', 'hra', 'base', 'tax', 'tds', 'pf', 'esi', 'uan', 'pan', 'otp', 'pin', 'dob', 'birth',
  'ead', 'visa', 'email', 'phone', 'mobile', 'contact', 'address', 'url', 'key', 'hash',
]);
// A value that is itself a link or an email address is hidden whatever its field is called.
const SENSITIVE_VALUE_RE = /https?:\/\/|[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;
const MAX_CHANGES = 10;
const MAX_VALUE_CHARS = 200;

export function isSensitiveName(name) {
  const s = String(name || '');
  if (SENSITIVE_SUBSTRING_RE.test(s)) return true;
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => SENSITIVE_WORDS.has(w));
}

function boundValue(v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
}

function change(field, from, to, action) {
  if (isSensitiveName(field) || isSensitiveName(action)) return { field, valueHidden: true };
  const pair = { from: boundValue(from), to: boundValue(to) };
  if ([pair.from, pair.to].some((v) => v && SENSITIVE_VALUE_RE.test(v))) return { field, valueHidden: true };
  return { field, ...pair };
}

/**
 * Old → new values, only where the log row stores them: metadata.changes (the ATS array, or the
 * { field: { from, to } } object older rows kept — normalised by the ATS helper), placement
 * fromValue/toValue, field/newValue, <x>Before/<x>After pairs and top-level from/to (employee
 * transfer). Sensitive values are never returned (isSensitiveName: field named, value hidden).
 * null = the row stores no change detail.
 */
export function changesFrom(action, metadata) {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
  if (!m) return null;
  const out = [];
  if (m.changes && typeof m.changes === 'object') {
    for (const c of normalizeChangesArray(m.changes)) {
      if (!c?.field) continue;
      const field = String(c.field);
      if ('from' in c || 'to' in c) out.push(change(field, c.from, c.to, action));
      else out.push({ field, valuesNotCaptured: true });
    }
  }
  if ('fromValue' in m || 'toValue' in m) out.push(change(String(m.field ?? 'value'), m.fromValue, m.toValue, action));
  else if (m.field != null && 'newValue' in m) out.push(change(String(m.field), m.oldValue, m.newValue, action));
  for (const key of Object.keys(m)) {
    if (!key.endsWith('Before') || key.length <= 6) continue;
    const base = key.slice(0, -6);
    if (`${base}After` in m) out.push(change(base, m[key], m[`${base}After`], action));
  }
  if ('before' in m && 'after' in m) out.push(change('value', m.before, m.after, action));
  else if ('from' in m && 'to' in m) out.push(change('value', m.from, m.to, action));
  return out.length ? out.slice(0, MAX_CHANGES) : null;
}

export function auditCountFacts(kind, label, total) {
  const fact = { kind, label, total };
  return { counts: [fact], primary: fact };
}
