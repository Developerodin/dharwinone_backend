import config from '../config/config.js';
import logger from '../config/logger.js';
import SopNotificationState from '../models/sopNotificationState.model.js';
import { createNotification } from './notification.service.js';
import { evaluateSopForCandidate, listSopOpenOverviewForManage } from './sopChecklist.service.js';
import Candidate from '../models/candidate.model.js';

const dateBucketUtc = () => new Date().toISOString().slice(0, 10);

/**
 * Fire-and-forget after candidate / training changes when NOTIFY_SOP_REMINDERS is enabled.
 * @param {string} candidateId
 * @param {object|null} [precomputedEval] - result of evaluateSopForCandidate when already computed (e.g. GET sop-status).
 */
/**
 * Queue reminder checks for candidates that still have open SOP steps (same pool as sop-open-overview).
 * Use after deploy or when in-app notifications were empty — respects NOTIFY_SOP_REMINDERS and per-day dedupe.
 * @param {{ limit?: number }} opts
 */
export const dispatchSopRemindersForOpenCandidates = async ({ limit = 150 } = {}) => {
  if (!config.notifySopReminders) {
    return { queued: 0, skipped: true, reason: 'NOTIFY_SOP_REMINDERS disabled' };
  }
  const overview = await listSopOpenOverviewForManage({ limit });
  let n = 0;
  for (const row of overview.results) {
    queueSopReminderCheckForCandidate(row.candidateId);
    n += 1;
  }
  return {
    queued: n,
    scanned: overview.scannedCount,
    withOpen: overview.withOpenStepsCount,
  };
};

export const queueSopReminderCheckForCandidate = (candidateId, precomputedEval = null) => {
  if (!config.notifySopReminders) return;
  if (!candidateId) return;
  setImmediate(() => {
    runSopReminderCheckForCandidate(candidateId, precomputedEval).catch((e) => {
      logger.warn(`[SOP notify] ${candidateId}: ${e?.message || e}`);
    });
  });
};

async function runSopReminderCheckForCandidate(candidateId, precomputedEval = null) {
  const evalResult = precomputedEval ?? (await evaluateSopForCandidate(candidateId));
  if (evalResult.skipped || !evalResult.steps?.length) return;

  const open = evalResult.steps.filter((s) => !s.done);
  if (!open.length) return;

  const candidate = await Candidate.findById(candidateId)
    .select('adminId assignedAgent assignedRecruiter fullName')
    .lean();
  if (!candidate) return;

  // Only stakeholders on this candidate — agents see reminders for assigned candidates only
  // (Settings → Agents assigns `assignedAgent`; recruiters use `assignedRecruiter`; `adminId` is legacy admin).
  const uniqueRecipients = [
    ...new Set(
      [candidate.adminId, candidate.assignedAgent, candidate.assignedRecruiter]
        .filter(Boolean)
        .map((id) => String(id))
    ),
  ];
  if (!uniqueRecipients.length) return;

  const bucket = dateBucketUtc();
  const name = candidate.fullName || 'Candidate';
  const v = evalResult.templateVersion ?? 0;
  // Signature distinguishes duplicate checkerKeys (e.g. two rows with agent_assigned) and order.
  const sig = open
    .map((s) => `${s.checkerKey}\t${s.sortOrder ?? 0}\t${s.label || ''}`)
    .sort()
    .join('|');

  const lines = open.map((s) => {
    const desc = (s.description || '').trim();
    return desc ? `• ${s.label} — ${desc}` : `• ${s.label}`;
  });
  const header =
    v > 0
      ? `Active SOP v${v} — ${open.length} incomplete step(s) for this candidate:`
      : `${open.length} incomplete onboarding step(s):`;
  let message = `${header}\n${lines.join('\n')}`;
  if (evalResult.nextStep && !evalResult.nextStep.done) {
    message += `\n\nNext recommended: ${evalResult.nextStep.label}`;
  }

  const link =
    evalResult.nextStep && !evalResult.nextStep.done && evalResult.nextStep.link
      ? evalResult.nextStep.link
      : `/ats/candidates/edit?id=${candidateId}`;

  for (const rid of uniqueRecipients) {
    let st = await SopNotificationState.findOne({
      recipientUser: rid,
      candidate: candidateId,
      checkerKey: '__batch__',
      dateBucket: bucket,
    });
    if (st && st.batchSignature === sig) continue;
    if (!st) {
      st = await SopNotificationState.create({
        recipientUser: rid,
        candidate: candidateId,
        checkerKey: '__batch__',
        dateBucket: bucket,
        batchSignature: sig,
      });
    } else {
      st.batchSignature = sig;
      st.lastNotifiedAt = new Date();
      await st.save();
    }
    await createNotification(rid, {
      type: 'sop',
      title: v > 0 ? `Onboarding (SOP v${v}): ${name}` : `Onboarding: ${name}`,
      message,
      link,
    });
  }
}
