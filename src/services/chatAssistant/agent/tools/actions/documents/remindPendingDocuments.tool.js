import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import {
  DOCUMENT_REQUEST_ACCESS, NO_ACCESS_MESSAGE, PROFILE_FIELDS,
  documentActionScope, documentActionDeps, canRequestDocuments, resolveVisibleProfile, resolveRecipient,
  recipientLine, sendNotice, listLabels, pendingRequests, requesterName, recheckByPrepare, idOf,
} from './common.js';

const NAME = 'remind_pending_documents';
const TITLE = 'Reminder: documents pending';
const DEDUPE_MS = 24 * 60 * 60 * 1000;

const plural = (n) => (n === 1 ? 'document' : 'documents');
const noticeMessage = (user, labels) =>
  `${requesterName(user)} is reminding you to upload: ${labels.join(', ')}.`;

/**
 * A reminder for this profile confirmed (by anyone) in the last 24 h. Reads SageAction history: terminal rows
 * live 24 h after they finish, so the window is always covered. ponytail: no index on tool / summary.targets.id;
 * fine while the collection holds a day of drafts — add { tool: 1, 'summary.targets.id': 1 } if it grows.
 * Two drafts for the same profile confirmed at the same instant can both send (neither is done yet).
 */
async function remindedRecently(profileId, deps) {
  const since = new Date(deps.now().getTime() - DEDUPE_MS);
  return deps.SageAction.findOne({
    tool: NAME,
    status: 'done',
    'summary.targets.id': profileId,
    confirmedAt: { $gte: since },
  }).select('_id').lean();
}

async function prepare({ person }, ctx) {
  const user = documentActionScope(ctx);
  const deps = documentActionDeps(ctx);
  if (!(await canRequestDocuments(user, ctx?.deps))) return { ok: false, error: NO_ACCESS_MESSAGE };

  const found = await resolveVisibleProfile(person, user, deps);
  if (found.error) return { ok: false, error: found.error };
  const emp = found.profile;
  const profileId = idOf(emp);
  const name = emp.fullName || 'this person';

  const pending = pendingRequests(emp);
  if (!pending.length) return { ok: false, error: `${name} has no pending document requests to remind them about.` };
  if (await remindedRecently(profileId, deps)) {
    return { ok: false, error: `${name} was already reminded about pending documents in the last 24 hours.` };
  }
  const recipient = await resolveRecipient(emp, deps);
  if (!recipient) return { ok: false, error: recipientLine(name, null) };

  const labels = pending.map((r) => r.label);
  return {
    ok: true,
    summary: {
      title: `Remind ${name} about ${labels.length} pending ${plural(labels.length)}`,
      lines: [
        `Remind ${name} about ${listLabels(labels)}.`,
        recipientLine(name, recipient),
        `Message: "${noticeMessage(user, labels)}"`,
      ],
      targetCount: 1,
      targets: [{ id: profileId, name }],
      confirmLabel: 'Send reminder',
    },
    payload: { profileId, pendingIndexes: pending.map((r) => r.index), recipient },
  };
}

export default defineTool({
  name: NAME,
  domain: 'actions',
  kind: 'write',
  description:
    'Draft one reminder notice (in-app and email) to a candidate or employee listing every document request of ' +
    'theirs that is still pending. Nothing is sent until the user presses Confirm. Use for "remind Priya about ' +
    'her pending documents", "nudge Ravi to upload what we asked for". One person per call; refused when they ' +
    'have no pending requests or were reminded in the last 24 hours. Not for asking for new documents ' +
    '(request_documents) or for checking what is pending (list_documents).',
  input: Joi.object({
    person: Joi.string().trim().min(1).max(120).required()
      .description('The one person, as the user named them: name, email, employee id or profile id.'),
  }),
  // No route sends this reminder; the same people who may request documents may remind about them.
  access: DOCUMENT_REQUEST_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: (draft, ctx) => recheckByPrepare(prepare, draft, ctx),
  async commit({ summary, payload }, ctx) {
    const user = documentActionScope(ctx);
    const deps = documentActionDeps(ctx);
    const { profileId, pendingIndexes, recipient } = payload;
    const name = summary?.targets?.[0]?.name ?? 'this person';

    // Replay-safe: once this (or any) reminder for the profile is done, a second commit sends nothing.
    if (await remindedRecently(profileId, deps)) {
      return {
        ok: true,
        message: `Skipped: ${name} was already reminded in the last 24 hours.`,
        details: { profileId, sent: false, skipped: 'reminded_recently' },
      };
    }
    const emp = await deps.Employee.findById(profileId).select(PROFILE_FIELDS).lean();
    if (!emp) return { ok: false, message: `${name}'s profile no longer exists; no reminder was sent.` };
    const requests = emp.documentRequests || [];
    const labels = pendingIndexes.map((i) => requests[i]).filter((r) => r?.status === 'pending').map((r) => r.label);
    if (!labels.length) {
      return {
        ok: true,
        message: `Nothing to remind ${name} about: those requests are no longer pending.`,
        details: { profileId, sent: false, skipped: 'nothing_pending' },
      };
    }
    const sent = await sendNotice(recipient, emp, { title: TITLE, message: noticeMessage(user, labels), triggeredBy: idOf(user) }, deps);
    if (!sent) return { ok: false, message: `The reminder to ${name} could not be sent.`, details: { profileId, sent: false } };
    return {
      ok: true,
      message: `Reminded ${name} (in-app and by email) about ${listLabels(labels)}.`,
      details: { profileId, sent: true, documentCount: labels.length },
    };
  },
});
