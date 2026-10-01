import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import { DOCUMENT_TYPES } from '../../../../../../models/employee.model.js';
import { canRequestPreBoardingDocs } from '../../../../../../controllers/employee.controller.js';
import { ActivityActions, EntityTypes } from '../../../../../../config/activityLog.js';
import {
  DOCUMENT_REQUEST_ACCESS, NO_ACCESS_MESSAGE, MAX_DOCUMENTS, PROFILE_FIELDS,
  documentActionScope, documentActionDeps, canRequestDocuments, resolveVisibleProfile, resolveRecipient,
  recipientLine, sendNotice, listLabels, pendingRequests, requesterName, sageAuditReq, recheckByPrepare, idOf, lc,
} from './common.js';

const NOTE_CAP = 120;
const TITLE = 'Documents requested';

const plural = (n) => (n === 1 ? 'document' : 'documents');
const clip = (s) => (s.length > NOTE_CAP ? `${s.slice(0, NOTE_CAP - 1)}…` : s);
const noticeMessage = (user, labels) => `${requesterName(user)} asked you to upload: ${labels.join(', ')}.`;
const requestLine = (d, name) =>
  `Request "${d.label}" (type ${d.type || 'Other'}) from ${name}${d.notes ? `, note: ${clip(d.notes)}` : ''}`;

async function prepare({ person, documents }, ctx) {
  const user = documentActionScope(ctx);
  const deps = documentActionDeps(ctx);
  if (!(await canRequestDocuments(user, ctx?.deps))) return { ok: false, error: NO_ACCESS_MESSAGE };

  const found = await resolveVisibleProfile(person, user, deps);
  if (found.error) return { ok: false, error: found.error };
  const emp = found.profile;
  const profileId = idOf(emp);
  const name = emp.fullName || 'this person';

  // A label already pending is not requested twice (the service itself would push a duplicate row).
  const pending = new Set(pendingRequests(emp).map((r) => lc(r.label)));
  const seen = new Set();
  const documentIndexes = [];
  const skipped = [];
  documents.forEach((d, i) => {
    const key = lc(d.label);
    if (seen.has(key)) return;
    seen.add(key);
    if (pending.has(key)) skipped.push(d.label);
    else documentIndexes.push(i);
  });
  if (!documentIndexes.length) {
    return { ok: false, error: `Every document you listed is already pending for ${name}: ${listLabels(skipped)}.` };
  }

  const recipient = await resolveRecipient(emp, deps);
  const toRequest = documentIndexes.map((i) => documents[i]);
  const lines = [
    ...toRequest.map((d) => requestLine(d, name)),
    ...(skipped.length ? [`Skip ${listLabels(skipped)}: already pending, not requested again.`] : []),
    recipientLine(name, recipient),
    recipient
      ? `Message: "${noticeMessage(user, toRequest.map((d) => d.label))}"`
      : 'The requests are still created; tell them yourself.',
  ];
  return {
    ok: true,
    summary: {
      title: `Request ${toRequest.length} ${plural(toRequest.length)} from ${name}`,
      lines,
      targetCount: 1,
      targets: [{ id: profileId, name }],
      confirmLabel: 'Request documents',
    },
    payload: { profileId, documentIndexes, recipient },
  };
}

export default defineTool({
  name: 'request_documents',
  domain: 'actions',
  kind: 'write',
  description:
    'Draft asking one candidate or employee to upload specific documents (the Pre-boarding Documents "Request ' +
    'document" action), plus one notice to that person. Nothing is requested until the user presses Confirm. Use ' +
    'for "ask Priya for her passport and PAN", "request the signed offer letter from Ravi". One person per call, ' +
    'at most 10 documents; documents already pending are skipped. Not for checking which documents someone has ' +
    'or is missing (list_documents), and not for reminding about requests already made (remind_pending_documents).',
  input: Joi.object({
    person: Joi.string().trim().min(1).max(120).required()
      .description('The one person, as the user named them: name, email, employee id or profile id.'),
    documents: Joi.array()
      .items(Joi.object({
        label: Joi.string().trim().min(1).max(120).required()
          .description('What to upload, as the person will see it, e.g. "Passport (all pages)".'),
        type: Joi.string().valid(...DOCUMENT_TYPES).description('Document type; Other when none fits.'),
        notes: Joi.string().trim().min(1).max(500).description('Optional instructions for the person.'),
      }))
      .min(1)
      .max(MAX_DOCUMENTS)
      .required()
      .description('The documents to request, 1 to 10.'),
  }),
  access: DOCUMENT_REQUEST_ACCESS,
  maxTargets: 1,
  prepare,
  recheck: (draft, ctx) => recheckByPrepare(prepare, draft, ctx),
  async commit({ args, summary, payload }, ctx) {
    const user = documentActionScope(ctx);
    const deps = documentActionDeps(ctx);
    const { profileId, documentIndexes, recipient } = payload;
    const name = summary?.targets?.[0]?.name ?? 'this person';
    const emp = await deps.Employee.findById(profileId).select(PROFILE_FIELDS).lean();
    if (!emp) return { ok: false, message: `${name}'s profile no longer exists; nothing was requested.` };

    // What the route's controller sets before calling the service; the service reads only this and the id.
    const actor = { _id: idOf(user), canManageCandidates: canRequestPreBoardingDocs({ authContext: user.authContext }) };
    const pending = new Set(pendingRequests(emp).map((r) => lc(r.label)));
    const created = [];
    const skipped = [];
    const failed = [];
    for (const d of documentIndexes.map((i) => args.documents[i])) {
      if (pending.has(lc(d.label))) {
        skipped.push(d.label);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.requestDocumentFromCandidate(profileId, { label: d.label, type: d.type, notes: d.notes }, actor);
      } catch (err) {
        failed.push(`${d.label} (${err?.message || 'failed'})`);
        continue;
      }
      created.push(d.label);
      pending.add(lc(d.label));
      try {
        // Same audit row the route writes after each request (employee.controller.js requestDocument).
        // eslint-disable-next-line no-await-in-loop
        await deps.writeAtsAudit(
          idOf(user),
          {
            action: ActivityActions.EMPLOYEE_DOCUMENT_REQUEST,
            entityType: EntityTypes.EMPLOYEE,
            entityId: profileId,
            metadata: { documentType: d.type },
          },
          sageAuditReq(ctx),
          { editContext: { staffEdit: true } }
        );
      } catch {
        // Fail-soft like the route: the request already landed.
      }
    }

    // The notice lists only what this commit created, so a replay (all skipped) sends nothing.
    let notice = '';
    let notified = false;
    if (created.length && recipient) {
      notified = await sendNotice(recipient, emp, { title: TITLE, message: noticeMessage(user, created), triggeredBy: idOf(user) }, deps);
      notice = notified ? ` ${name} was notified in-app and by email.` : ' The notice to them could not be sent.';
    } else if (created.length) {
      notice = ` No notice was sent: there is no way to notify ${name}.`;
    }
    const parts = [
      created.length ? `Requested ${listLabels(created)} from ${name}.${notice}` : `Nothing new was requested from ${name}.`,
      ...(skipped.length ? [`Already pending, skipped: ${listLabels(skipped)}.`] : []),
      ...(failed.length ? [`Failed: ${failed.join('; ')}.`] : []),
    ];
    return {
      // A partial create is a failed action: the row must not be stored done, and the
      // message lists only what was created plus what failed.
      ok: failed.length === 0,
      message: parts.join(' '),
      details: { profileId, created, skipped, failed, notified },
    };
  },
});
