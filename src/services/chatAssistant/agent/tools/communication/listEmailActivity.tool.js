import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { escapeRegex } from '../../../../../utils/courseSearch.util.js';
import { dayWindowBounds } from '../employees/common.js';
import {
  EMAIL_ACTIVITY_ACCESS, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, bound, communicationDeps, communicationUserId,
} from './common.js';

const EMAIL_STATUSES = ['sent', 'failed', 'suppressed', 'pending'];
const MAX_NAME_MATCHES = 50;
const MAX_ERROR_CHARS = 300;
const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked by dayWindowBounds

/**
 * Name → the addresses a platform email to that person would carry: the login email and the
 * company-assigned email (sendEmail's resolveDeliveryEmail prefers the latter). Through queryUsers (the
 * Users directory), so hidden accounts never resolve for a non-platform-super viewer.
 * Ceiling: the first MAX_NAME_MATCHES users only.
 */
async function addressesForName(name, user, deps) {
  const filter = { search: name };
  if (!user.platformSuperUser) filter.platformSuperUser = { $ne: true };
  const page = await deps.queryUsers(filter, { limit: MAX_NAME_MATCHES, page: 1 }, user);
  const people = new Map();
  for (const u of page?.results || []) {
    for (const addr of [u.email, u.companyAssignedEmail]) {
      const a = String(addr || '').trim().toLowerCase();
      if (a) people.set(a, u.name || null);
    }
  }
  return people;
}

export default defineTool({
  name: 'list_email_activity',
  domain: 'communication',
  kind: 'read',
  description:
    'Delivery log of emails the PLATFORM sent (invites, offer / meeting / task notifications, password resets, ' +
    'verification): recipient, type, subject, status (sent / failed / suppressed / pending), the failure reason ' +
    'and when. Use for "was Priya\'s offer email delivered", "did the meeting invite reach asha@acme.com", ' +
    '"which emails failed yesterday", "was the password reset email sent to Ravi". Never a mailbox — for the ' +
    'user\'s own inbox use search_my_mailbox.',
  measure:
    'Platform EMAIL SEND ATTEMPTS (one row per recipient per email), newest first, every status unless filtered. ' +
      '"sent" means the mail server accepted it — inbox delivery, opens and bounces are not captured.',
  input: Joi.object({
    filters: Joi.object({
      person: Joi.string().min(1).max(200)
        .description('Recipient: a person\'s name, or an email address (or part of one).'),
      status: Joi.string().valid(...EMAIL_STATUSES)
        .description('sent = accepted by the mail server; failed = the send errored; suppressed = the ' +
          'recipient\'s notification settings blocked it; pending = never finished.'),
      type: Joi.string().min(2).max(60)
        .description('Email type, matched as part of the template name: e.g. "offer", "meetingInvitation", ' +
          '"resetPassword", "verifyEmail", "candidateInvitation", "reminder", "notification_task".'),
      between: Joi.object({ from: isoDay, to: isoDay }).description('When it was sent: inclusive whole days (IST).'),
    }),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  }),
  access: EMAIL_ACTIVITY_ACCESS,
  async execute({ filters, limit = DEFAULT_LIST_LIMIT } = {}, ctx) {
    communicationUserId(ctx);
    const user = ctx.user;
    const deps = communicationDeps(ctx);
    const f = filters || {};
    const and = [];
    let names = new Map();

    const person = String(f.person || '').trim();
    if (person.includes('@')) {
      and.push({ to: { $regex: escapeRegex(person.toLowerCase()) } });
    } else if (person) {
      names = await addressesForName(person, user, deps);
      if (!names.size) return { total: 0, records: [], notFound: 'person', filtersApplied: f };
      and.push({ to: { $in: [...names.keys()] } });
    }
    if (f.status) and.push({ status: f.status });
    if (f.type) and.push({ templateName: { $regex: escapeRegex(f.type), $options: 'i' } });
    const { from, to } = dayWindowBounds(f.between);
    if (from || to) {
      and.push({ createdAt: { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) } });
    }
    // Same rule as the Users directory: mail to directory-hidden accounts is not listed for viewers who
    // cannot see them. Ceiling: matches their login email only, not a company-assigned one.
    if (!deps.viewerSeesHiddenUsers(user)) {
      const hiddenIds = await deps.getDirectoryHiddenUserIds();
      if (hiddenIds.length) {
        const hidden = await deps.User.distinct('email', { _id: { $in: hiddenIds } });
        if (hidden.length) and.push({ to: { $nin: hidden.map((e) => String(e).toLowerCase()) } });
      }
    }

    const { total, results } = await deps.queryEmailLogs(and.length ? { $and: and } : {}, {
      limit: Math.min(limit, MAX_LIST_LIMIT),
    });
    const rows = results || [];
    const unnamed = [...new Set(rows.map((r) => r.to).filter((a) => a && !names.has(a)))];
    if (unnamed.length) {
      const users = await deps.User.find({ email: { $in: unnamed } }).select('name email').lean();
      for (const u of users) names.set(String(u.email).toLowerCase(), u.name || null);
    }

    return {
      total: total ?? 0,
      records: rows.map((r) => ({
        to: r.to ?? null,
        person: names.get(r.to) ?? null,
        type: r.templateName ?? null,
        subject: r.subject ?? null,
        status: r.status ?? null,
        error: bound(r.error, MAX_ERROR_CHARS),
        sentAt: r.sentAt ?? null,
        attemptedAt: r.createdAt ?? null,
      })),
      filtersApplied: f,
    };
  },
  render(result) {
    if (!result?.records?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'email-activity',
        tableType: 'email-activity',
        title: `Platform emails (${result.total})`,
        columns: [
          { key: 'to', label: 'To', priority: 'primary' },
          { key: 'type', label: 'Type', priority: 'secondary' },
          { key: 'subject', label: 'Subject', priority: 'primary' },
          { key: 'status', label: 'Status', priority: 'primary' },
          { key: 'attemptedAt', label: 'When', priority: 'primary', format: 'date' },
          { key: 'error', label: 'Error', priority: 'secondary' },
        ],
        rows: result.records.map((r) => ({
          to: r.person ? `${r.person} <${r.to}>` : (r.to ?? '—'),
          type: r.type ?? '—',
          subject: r.subject ?? '—',
          status: r.status ?? '—',
          attemptedAt: r.attemptedAt ?? null,
          error: r.error ?? '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
