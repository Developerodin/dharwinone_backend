import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import EmailLogModel from '../../../../../models/emailLog.model.js';
import CallRecordModel from '../../../../../models/callRecord.model.js';
import InterviewHoldModel from '../../../../../models/interviewHold.model.js';
import JobApplicationModel from '../../../../../models/jobApplication.model.js';
import EmployeeModel from '../../../../../models/employee.model.js';
import { applicationScope as realApplicationScope } from '../../../../visibilityScope.service.js';
import { dateStrInTz } from '../../../../../utils/zonedTime.js';
import { hiringScope, MAX_LIST_LIMIT } from './common.js';

// Same note as list_applications: the Applications page has no anyOf; applicationScope is the gate.
export const AWAITING_ACCESS = Object.freeze({ note: 'applicantQuery.service applicationScope' });

// applicantQuery.service searchApplications always sets excludeInternal with this pattern.
const RELAY_EMAIL_RE = /(\.noreply@dharwin\.offers\.local$)|(\.(local|internal|invalid)$)/i;
/** A picked slot. Rejected / expired / cancelled holds are not a current pick — the candidate was sent another link. */
const PICKED = Object.freeze(['held', 'approving', 'approved']);
const IST = 'Asia/Kolkata';
// ponytail: newest 500 sends and 500 call-record claims. Past that, scanTruncated and the oldest
// waiting candidates can be missing; page by sent date if the booking-link log outgrows this.
export const BOOKING_SCAN_LIMIT = 500;

function awaitingDeps(ctx) {
  const d = ctx?.deps || {};
  return {
    EmailLog: d.EmailLog ?? EmailLogModel,
    CallRecord: d.CallRecord ?? CallRecordModel,
    InterviewHold: d.InterviewHold ?? InterviewHoldModel,
    JobApplication: d.JobApplication ?? JobApplicationModel,
    Employee: d.Employee ?? EmployeeModel,
    applicationScope: d.applicationScope ?? realApplicationScope,
    now: d.now ?? (() => new Date()),
  };
}

function scopeIsEmpty(filter) {
  const inn = filter?._id?.$in;
  return Array.isArray(inn) && inn.length === 0;
}

function istAgeDays(sentAt, now) {
  const sent = new Date(sentAt);
  if (Number.isNaN(sent.getTime())) return null;
  const a = dateStrInTz(sent, IST);
  const b = dateStrInTz(now, IST);
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function touch(sentAt, id, at) {
  if (id == null || id === '') return;
  const key = String(id);
  const prev = sentAt.get(key);
  if (prev === undefined) {
    sentAt.set(key, at ?? null);
    return;
  }
  const nextMs = at ? new Date(at).getTime() : NaN;
  const prevMs = prev ? new Date(prev).getTime() : NaN;
  if (Number.isFinite(nextMs) && (!Number.isFinite(prevMs) || nextMs > prevMs)) sentAt.set(key, at);
}

export default defineTool({
  name: 'list_awaiting_availability',
  domain: 'hiring',
  kind: 'read',
  description:
    'Candidates who were sent an interview booking link and have not picked a current slot. Link sent date and ' +
    'age in whole IST days. A hold that is held, approving, or approved means they picked — they are left out. ' +
    'Rejected, expired, or cancelled holds do not count as a pick. Only applications this user can see on the ' +
    'Applications page. Use for "who hasn\'t chosen a time", "booking link sent but no slot".',
  measure:
    'Job applications you can see that have a sent booking-link email or a recorded bookingLinkSentAt and no ' +
      'current interview hold (held, approving, or approved).',
  input: Joi.object({}),
  access: AWAITING_ACCESS,
  async execute(_args, ctx) {
    const user = hiringScope(ctx);
    const deps = awaitingDeps(ctx);
    const { filter: scopeFilter } = await deps.applicationScope(user, 'read');
    if (scopeIsEmpty(scopeFilter)) return { total: 0, records: [], scopedToYou: true };

    const relayRows = await deps.Employee.find({ email: RELAY_EMAIL_RE }).select('_id').lean();
    const relayIds = (relayRows || []).map((r) => r._id).filter((id) => id != null);
    const relayClause = relayIds.length ? [{ candidate: { $nin: relayIds } }] : [];

    const [logs, calls] = await Promise.all([
      deps.EmailLog.find({ templateName: 'interview_booking_link', status: 'sent' })
        .select('sentAt createdAt metadata.applicationId')
        .sort({ createdAt: -1 })
        .limit(BOOKING_SCAN_LIMIT)
        .lean(),
      deps.CallRecord.find({ bookingLinkSentAt: { $ne: null } })
        .select('bookingLinkSentAt candidate job')
        .sort({ bookingLinkSentAt: -1 })
        .limit(BOOKING_SCAN_LIMIT)
        .lean(),
    ]);

    const sentAt = new Map();
    for (const log of logs || []) {
      touch(sentAt, log.metadata?.applicationId, log.sentAt || log.createdAt || null);
    }

    const pairs = (calls || []).filter((c) => c.candidate && c.job);
    if (pairs.length) {
      const callApps = await deps.JobApplication.find({
        $and: [scopeFilter, { $or: pairs.map((c) => ({ candidate: c.candidate, job: c.job })) }, ...relayClause],
      }).select('_id candidate job').lean();
      const byPair = new Map((callApps || []).map((a) => [`${String(a.candidate)}:${String(a.job)}`, a]));
      for (const c of pairs) {
        const app = byPair.get(`${String(c.candidate)}:${String(c.job)}`);
        if (app) touch(sentAt, app._id ?? app.id, c.bookingLinkSentAt);
      }
    }

    const scanTruncated = (logs || []).length >= BOOKING_SCAN_LIMIT || (calls || []).length >= BOOKING_SCAN_LIMIT;
    const ids = [...sentAt.keys()];
    if (!ids.length) return { total: 0, records: [], scanTruncated, ...(scopeFilter && Object.keys(scopeFilter).length ? { scopedToYou: true } : {}) };

    const picked = await deps.InterviewHold.distinct('applicationId', {
      applicationId: { $in: ids },
      status: { $in: PICKED },
    });
    const pickedSet = new Set((picked || []).map(String));
    const awaitingIds = ids.filter((id) => !pickedSet.has(id));
    const apps = awaitingIds.length
      ? await deps.JobApplication.find({
        $and: [scopeFilter, { _id: { $in: awaitingIds } }, ...relayClause],
      }).select('candidate job status').populate('candidate', 'fullName').populate('job', 'title').lean()
      : [];

    const now = deps.now();
    const records = (apps || []).map((a) => {
      const id = String(a._id ?? a.id);
      const at = sentAt.get(id) ?? null;
      return {
        applicationId: id,
        candidate: a.candidate?.fullName ?? null,
        job: a.job?.title ?? null,
        status: a.status ?? null,
        linkSentAt: at,
        ageDays: at ? istAgeDays(at, now) : null,
      };
    }).sort((x, y) => (y.ageDays ?? -1) - (x.ageDays ?? -1));

    const scoped = scopeFilter && Object.keys(scopeFilter).length > 0;
    return {
      total: records.length,
      records: records.slice(0, MAX_LIST_LIMIT),
      ...(records.length > MAX_LIST_LIMIT ? { truncated: true } : {}),
      scanTruncated,
      ...(scoped ? { scopedToYou: true } : {}),
    };
  },
  render(result) {
    if (!result?.records?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'awaiting-availability',
        title: `Waiting to pick a slot (${result.total})`,
        columns: [
          { key: 'candidate', label: 'Candidate', priority: 'primary' },
          { key: 'job', label: 'Job', priority: 'primary' },
          { key: 'ageDays', label: 'Days waiting', priority: 'primary' },
        ],
        rows: result.records.slice(0, 12).map((r) => ({
          candidate: r.candidate ?? '—',
          job: r.job ?? '—',
          ageDays: r.ageDays == null ? '—' : String(r.ageDays),
        })),
      }],
    };
  },
});
