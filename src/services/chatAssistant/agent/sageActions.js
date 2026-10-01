// Sage's confirm-first writes. A write tool only drafts: toolRegistry.execute calls
// createDraft, which runs the tool's read-only prepare and stores a pending SageAction.
// The model never performs the write — the user's POST /v1/chat-assistant/actions/:key/confirm
// does, through confirmAction: atomic claim, access + args re-check, recheck or re-prepare,
// then commit. Every confirm that gets past the claim ends done or failed and writes one
// activity log row (metadata.source = 'sage').

import { randomUUID } from 'node:crypto';
import httpStatus from 'http-status';
import config from '../../../config/config.js';
import SageAction from '../../../models/sageAction.model.js';
import { ActivityActions, EntityTypes } from '../../../config/activityLog.js';
import { createActivityLog as defaultCreateActivityLog } from '../../activityLog.service.js';
import { checkAccessRule } from '../toolAccess.js';
import { runWithTimeout } from './runWithTimeout.js';
import { findTool as defaultFindTool } from './compose.js';

const DRAFT_TTL_MS = 15 * 60 * 1000;
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

export const IMPERSONATION_MESSAGE = 'Actions are disabled while impersonating';
export const STALE_MESSAGE = 'The data changed since the draft — ask Sage again.';
const NOT_FOUND_MESSAGE = 'This action was not found.';
const EXPIRED_MESSAGE = 'This draft has expired — ask Sage again.';
const CANCELLED_MESSAGE = 'Cancelled.';
const STATUS_MESSAGES = {
  executing: 'This action is already running.',
  done: 'Done.',
  failed: 'The action failed.',
  cancelled: 'This action was cancelled.',
};

const userIdOf = (user) => {
  const id = user?.id ?? user?._id;
  return id ? String(id) : null;
};

const timeoutOf = (tool) => tool.timeoutMs ?? config.chatbot.agent.toolTimeoutMs;

const later = (from, ms) => new Date(from.getTime() + ms);

const reply = (code, status, message) => ({ code, body: { status, message } });

const withDetails = (body, details) => (details !== undefined ? { ...body, details } : body);

/** The stored outcome of a row that can no longer be confirmed. */
const storedBody = (row) =>
  withDetails(
    { status: row.status, message: row.result?.message ?? STATUS_MESSAGES[row.status] ?? 'This action cannot be confirmed.' },
    row.result?.details
  );

/**
 * Validate what a tool's prepare returned. `{ ok: true, summary, payload }` with every
 * target listed (targets.length === targetCount ≤ tool.maxTargets), or `{ ok: false, error }`.
 */
export function checkPrepared(prepared, tool) {
  if (!prepared || typeof prepared !== 'object') return { ok: false, error: `${tool.name}: prepare returned nothing` };
  if (prepared.ok !== true) return { ok: false, error: String(prepared.error || 'Could not prepare the action.') };
  const { summary, payload } = prepared;
  const valid =
    !!summary &&
    typeof summary.title === 'string' &&
    summary.title.trim().length > 0 &&
    Array.isArray(summary.lines) &&
    summary.lines.every((l) => typeof l === 'string') &&
    Number.isInteger(summary.targetCount) &&
    summary.targetCount >= 0 &&
    Array.isArray(summary.targets) &&
    summary.targets.every((t) => t && t.id != null && typeof t.name === 'string') &&
    (summary.confirmLabel === undefined || typeof summary.confirmLabel === 'string');
  if (!valid) return { ok: false, error: `${tool.name}: prepare returned a malformed summary` };
  if (summary.targetCount > tool.maxTargets) {
    return {
      ok: false,
      error: `This would affect ${summary.targetCount} records; at most ${tool.maxTargets} can be changed at once. Narrow it down.`,
    };
  }
  if (summary.targets.length !== summary.targetCount) {
    return { ok: false, error: `${tool.name}: prepare must list every target (${summary.targets.length} of ${summary.targetCount})` };
  }
  if (payload === undefined) return { ok: false, error: `${tool.name}: prepare returned no payload` };
  return {
    ok: true,
    summary: {
      title: summary.title,
      lines: summary.lines,
      targetCount: summary.targetCount,
      targets: summary.targets.map((t) => ({ id: String(t.id), name: t.name })),
      ...(summary.confirmLabel ? { confirmLabel: summary.confirmLabel } : {}),
    },
    payload,
  };
}

const sortedTargetIds = (summary) => (summary?.targets ?? []).map((t) => String(t.id)).sort();

function sameTargets(fresh, drafted) {
  const a = sortedTargetIds(fresh);
  const b = sortedTargetIds(drafted);
  return fresh.targetCount === drafted?.targetCount && a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The chat block the frontend renders with Confirm / Cancel buttons. */
export function confirmBlock({ key, summary, expiresAt }) {
  return {
    type: 'confirm',
    key,
    title: summary.title,
    lines: summary.lines,
    targetCount: summary.targetCount,
    confirmLabel: summary.confirmLabel || 'Confirm',
    expiresAt,
  };
}

/**
 * Run a write tool's prepare (validated args, under its timeout) and store the pending
 * draft. Returns what the loop hands the model: `{ ok: true, result: { draft, key, summary,
 * expiresAt } }` or `{ ok: false, error }`. Nothing but the SageAction row is written.
 */
export async function createDraft(tool, value, ctx) {
  const userId = userIdOf(ctx.user);
  if (!userId) return { ok: false, error: 'Actions need a signed-in user.' };

  let prepared;
  try {
    prepared = checkPrepared(await runWithTimeout(() => tool.prepare(value, ctx), timeoutOf(tool)), tool);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (!prepared.ok) return prepared;

  const createdAt = new Date();
  const doc = {
    key: randomUUID(),
    userId,
    tool: tool.name,
    args: value,
    summary: prepared.summary,
    payload: prepared.payload,
    status: 'pending',
    expiresAt: later(createdAt, DRAFT_TTL_MS),
    requestId: ctx.requestId ?? null,
  };
  await SageAction.create(doc);
  return {
    ok: true,
    result: { draft: true, key: doc.key, summary: prepared.summary, expiresAt: doc.expiresAt.toISOString() },
  };
}

/** Why a key could not be claimed: missing / someone else's → 404, expired → 410, otherwise 409 with its result. */
async function explainUnclaimed(key, userId, at) {
  const row = await SageAction.findOne({ key, userId }).lean();
  if (!row) return reply(httpStatus.NOT_FOUND, 'not_found', NOT_FOUND_MESSAGE);
  if (row.status === 'expired') return reply(httpStatus.GONE, 'expired', EXPIRED_MESSAGE);
  if (row.status === 'pending' && row.expiresAt <= at) {
    // Only while the row still exists: the TTL monitor (every ~60 s) deletes an expired
    // pending row, after which the key answers 404. Marking it expired keeps it for 24 h.
    await SageAction.updateOne(
      { key, status: 'pending', expiresAt: { $lte: at } },
      { $set: { status: 'expired', expiresAt: later(at, RESULT_TTL_MS) } }
    );
    return reply(httpStatus.GONE, 'expired', EXPIRED_MESSAGE);
  }
  return { code: httpStatus.CONFLICT, body: storedBody(row) };
}

/**
 * POST /actions/:key/confirm. Returns `{ code, body: { status, message, details? } }`.
 * @param {{ key:string, user:object, impersonating?:boolean, req?:object }} args
 * @param {{ findTool?:Function, createActivityLog?:Function, now?:Function }} [deps] also passed to
 *   checkAccessRule and to the tool's ctx.deps, as toolRegistry does
 */
export async function confirmAction({ key, user, impersonating = false, req = null }, deps = {}) {
  const { findTool = defaultFindTool, createActivityLog = defaultCreateActivityLog, now = () => new Date() } = deps;
  if (impersonating) return reply(httpStatus.FORBIDDEN, 'refused', IMPERSONATION_MESSAGE);
  const userId = userIdOf(user);
  if (!userId) return reply(httpStatus.NOT_FOUND, 'not_found', NOT_FOUND_MESSAGE);

  // The atomic claim is the only way into commit: a second confirm (double click, retry,
  // two tabs) finds the row no longer pending and gets 409, so nothing runs twice.
  const claimedAt = now();
  const row = await SageAction.findOneAndUpdate(
    { key, userId, status: 'pending', expiresAt: { $gt: claimedAt } },
    { $set: { status: 'executing', confirmedAt: claimedAt, expiresAt: later(claimedAt, RESULT_TTL_MS) } },
    { new: true }
  ).lean();
  if (!row) return explainUnclaimed(key, userId, claimedAt);

  const targets = row.summary?.targets ?? [];
  const finish = async (status, result, outcome, code) => {
    await SageAction.updateOne(
      { key, status: 'executing' },
      { $set: { status, result, expiresAt: later(now(), RESULT_TTL_MS) } }
    );
    // The audit row must never change the response: createActivityLog is fail-soft, and a
    // throw from its request-geo lookup is swallowed here.
    await Promise.resolve()
      .then(() =>
        createActivityLog(
          userId,
          status === 'done' ? ActivityActions.SAGE_ACTION_CONFIRMED : ActivityActions.SAGE_ACTION_FAILED,
          EntityTypes.SAGE_ACTION,
          key,
          {
            source: 'sage',
            tool: row.tool,
            targetCount: row.summary?.targetCount ?? targets.length,
            targetIds: targets.slice(0, 50).map((t) => String(t.id)),
            outcome,
          },
          req
        )
      )
      .catch(() => null);
    return { code, body: withDetails({ status, message: result.message }, result.details) };
  };
  const failWith = (message, outcome, code = httpStatus.CONFLICT) => finish('failed', { ok: false, message }, outcome, code);

  // ponytail: a thrown error anywhere below ends the row failed, never executing. A process
  // crash mid-commit still leaves it executing. The claim bumps expiresAt to now+24h (same as
  // the terminal bump) so the TTL index cannot delete the row mid-commit. A later confirm
  // reports it executing until that window ends — whether the write landed is unknown;
  // the upgrade is a sweeper that marks stale executing rows failed/unknown.
  let committed;
  try {
    const tool = await findTool(row.tool);
    if (!tool || tool.kind !== 'write') return await failWith('This action is no longer available.', 'unavailable');

    // Permissions may have changed since the draft.
    const access = await checkAccessRule(tool.access, user, deps);
    if (!access.ok) return await failWith(access.reason || 'Not permitted.', 'forbidden', httpStatus.FORBIDDEN);

    const { value, error } = tool.input.validate(row.args ?? {}, { abortEarly: false });
    if (error) return await failWith(STALE_MESSAGE, 'invalid_args');

    const draft = { key, tool: row.tool, args: value, summary: row.summary, payload: row.payload };
    const ctx = { user, requestId: req?.id ?? null, deps };
    if (tool.recheck) {
      const checked = await runWithTimeout(() => tool.recheck(draft, ctx), timeoutOf(tool));
      if (!checked?.ok) return await failWith(String(checked?.error || STALE_MESSAGE), 'stale');
    } else {
      // Never silently act on a different set than the user saw.
      const fresh = checkPrepared(await runWithTimeout(() => tool.prepare(value, ctx), timeoutOf(tool)), tool);
      if (!fresh.ok) return await failWith(fresh.error, 'stale');
      if (!sameTargets(fresh.summary, row.summary)) return await failWith(STALE_MESSAGE, 'stale');
    }

    // No timeout on commit: a timeout would not stop the write underneath, so the row
    // would say failed while the write still lands.
    committed = (await tool.commit(draft, ctx)) ?? null;
    const ok = committed?.ok === true;
    const result = withDetails(
      { ok, message: String(committed?.message || (ok ? 'Done.' : 'The action failed.')) },
      committed?.details
    );
    return await finish(ok ? 'done' : 'failed', result, ok ? 'done' : 'commit_failed', httpStatus.OK);
  } catch (err) {
    // Commit already returned, so only recording its result failed: never relabel a write
    // that landed as failed. The error reaches the route's handler; the row stays executing.
    if (committed !== undefined) throw err;
    return failWith(err?.message || String(err), 'error', httpStatus.INTERNAL_SERVER_ERROR);
  }
}

/** POST /actions/:key/cancel — pending → cancelled, same ownership rules; cancelling twice is a no-op. */
export async function cancelAction({ key, user }, { now = () => new Date(), findTool = defaultFindTool } = {}) {
  const userId = userIdOf(user);
  if (!userId) return reply(httpStatus.NOT_FOUND, 'not_found', NOT_FOUND_MESSAGE);
  const pending = await SageAction.findOne({ key, userId, status: 'pending' }).lean();
  if (pending) {
    const tool = await Promise.resolve()
      .then(() => findTool(pending.tool))
      .catch(() => null);
    if (typeof tool?.onCancel === 'function') {
      // Void linked drafts (task-plan preview) before the row leaves pending, so a failed
      // void can be retried. A cancelled row must not stay applicable.
      await tool.onCancel(pending, { user });
    }
  }
  const cancelled = await SageAction.findOneAndUpdate(
    { key, userId, status: 'pending' },
    { $set: { status: 'cancelled', result: { ok: false, message: CANCELLED_MESSAGE }, expiresAt: later(now(), RESULT_TTL_MS) } },
    { new: true }
  ).lean();
  if (cancelled) return reply(httpStatus.OK, 'cancelled', CANCELLED_MESSAGE);

  const row = await SageAction.findOne({ key, userId }).lean();
  if (!row) return reply(httpStatus.NOT_FOUND, 'not_found', NOT_FOUND_MESSAGE);
  if (row.status === 'cancelled') return reply(httpStatus.OK, 'cancelled', CANCELLED_MESSAGE);
  return { code: httpStatus.CONFLICT, body: storedBody(row) };
}
