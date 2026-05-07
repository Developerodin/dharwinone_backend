/**
 * Reconciliation cron — safety net for missed Bolna webhooks.
 *
 * Two passes per tick:
 *   1. reconcileStuckRecords  — for any CallRecord stuck in non-terminal state
 *      for > 5 min, GET /execution/:id and feed the response through
 *      callSyncService.applyEvent. Catches dropped webhooks.
 *   2. backfillFromAgentList  — list recent Bolna agent executions and feed
 *      them through applyEvent. Catches calls Bolna fired but never told us
 *      about (e.g. webhook endpoint mis-configured).
 *
 * Both routes converge on callSyncService.applyEvent — the only writer of
 * Bolna-derived fields. No more inline status-merge / field-overwrite logic.
 */

import logger from '../config/logger.js';
import bolnaService from './bolna.service.js';
import callSyncService from './callSync.service.js';
import CallRecord, { TERMINAL_STATUSES } from '../models/callRecord.model.js';
import config from '../config/config.js';
import { expireStaleCalls } from './chatCall.service.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const RECONCILE_LOOKBACK_DAYS = 30;
const RECONCILE_BATCH = 100;
const BACKFILL_PAGE_SIZE = 50;
const BACKFILL_PAGES = 1;
/** Webhook stub age before unverified rows are auto-expired. */
const STUB_GHOST_GRACE_MS = 60 * 60 * 1000; // 1 hour
/** Bolna 404 grace before we expire a row we never seeded ourselves. */
const NOT_FOUND_GHOST_GRACE_MS = 30 * 60 * 1000; // 30 minutes
const GHOST_CLEANUP_BATCH = 50;

async function reconcileStuckRecords() {
  const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const lookbackCutoff = new Date(Date.now() - RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const stuck = await CallRecord.find({
    executionId: { $exists: true, $ne: null },
    status: { $nin: [...TERMINAL_STATUSES] },
    statusUpdatedAt: { $lte: stuckCutoff },
    createdAt: { $gte: lookbackCutoff },
  })
    .select('executionId status')
    .limit(RECONCILE_BATCH)
    .lean();

  if (!stuck.length) return { reconciled: 0, applied: 0, errors: 0 };

  let applied = 0;
  let errors = 0;
  for (const rec of stuck) {
    try {
      const r = await bolnaService.getExecutionDetails(rec.executionId);
      if (!r.success || !r.details) {
        errors += 1;
        continue;
      }
      // Bolna 404 → execution gone. Mark expired so we stop polling it.
      // Prefer the structured `notFound` flag from bolnaService over the
      // legacy "not found" substring match — wording can change.
      if (
        r.notFound === true ||
        (r.details.status === 'unknown' &&
          typeof r.details.error_message === 'string' &&
          r.details.error_message.includes('not found'))
      ) {
        const result = await callSyncService.applyEvent(
          {
            id: rec.executionId,
            execution_id: rec.executionId,
            status: 'expired',
            error_message: r.details.error_message,
            updated_at: new Date().toISOString(),
          },
          'reconciliation'
        );
        if (result.applied) applied += 1;
        continue;
      }
      const result = await callSyncService.applyEvent(
        { ...r.details, id: r.details.id ?? r.details.execution_id ?? rec.executionId },
        'reconciliation'
      );
      if (result.applied) applied += 1;
    } catch (err) {
      errors += 1;
      logger.warn(`[callSync cron] reconcile failed for ${rec.executionId}: ${err.message}`);
    }
  }
  return { reconciled: stuck.length, applied, errors };
}

async function backfillFromAgentList() {
  const agents = [config.bolna?.agentId, config.bolna?.candidateAgentId].filter(Boolean);
  const uniqueAgents = [...new Set(agents)];
  let scanned = 0;
  let applied = 0;
  let errors = 0;

  for (const agentId of uniqueAgents) {
    for (let page = 1; page <= BACKFILL_PAGES; page += 1) {
      try {
        const r = await bolnaService.getAgentExecutions({
          agentId,
          page_number: page,
          page_size: BACKFILL_PAGE_SIZE,
        });
        if (!r.success || !Array.isArray(r.data)) {
          errors += 1;
          break;
        }
        scanned += r.data.length;
        for (const exec of r.data) {
          const payload = {
            ...exec,
            id: exec.id ?? exec.execution_id,
            agent_id: exec.agent_id ?? agentId,
          };
          const result = await callSyncService.applyEvent(payload, 'backfill');
          if (result.applied) applied += 1;
        }
        if (!r.has_more) break;
      } catch (err) {
        errors += 1;
        logger.warn(`[callSync cron] backfill page ${page} agent=${agentId} failed: ${err.message}`);
      }
    }
  }
  return { scanned, applied, errors };
}

/**
 * ChatCall sweep — runs alongside Bolna reconciliation so ringing/ongoing rows
 * abandoned without a `room_finished` webhook (browser crash, network drop,
 * server restart mid-call) are closed within ~1min instead of waiting for the
 * 6h cutoff or a user opening the chat list.
 */
async function reconcileChatCalls() {
  try {
    const r = await expireStaleCalls();
    if ((r?.ringExpired || 0) + (r?.ongoingExpired || 0) > 0) {
      logger.info(`[callSync cron] chatCall ring=${r.ringExpired} ongoing=${r.ongoingExpired}`);
    }
    return r || { ringExpired: 0, ongoingExpired: 0 };
  } catch (err) {
    logger.warn(`[callSync cron] chatCall sweep failed: ${err.message}`);
    return { ringExpired: 0, ongoingExpired: 0, error: err.message };
  }
}

/**
 * Ghost-call cleanup. Three independent passes, each idempotent and bounded
 * by GHOST_CLEANUP_BATCH so a single tick never stalls the scheduler.
 *
 *  1. delete null-executionId rows (legacy data — should be impossible going
 *     forward thanks to the schema `required: true`, but we sweep anyway).
 *  2. expire `webhook` / `legacy` / `reconciliation` source rows whose
 *     `bolnaVerifiedAt` is null AND createdAt > STUB_GHOST_GRACE_MS old. These
 *     are stubs that never got confirmed by Bolna — almost always replays or
 *     foreign tenant noise.
 *  3. for any remaining non-terminal stub, hit Bolna once and either mark
 *     verified (sets bolnaVerifiedAt) or, if Bolna 404s and the row is older
 *     than NOT_FOUND_GHOST_GRACE_MS, mark `status='expired'` so it stops
 *     re-polling.
 */
export async function cleanupGhostCalls() {
  let deletedNull = 0;
  let expiredStubs = 0;
  let verifiedStubs = 0;
  let expiredNotFound = 0;
  let errors = 0;

  // Pass 1 — null executionId. Schema now forbids these, but old rows persist.
  try {
    const r = await CallRecord.deleteMany({
      $or: [{ executionId: null }, { executionId: '' }, { executionId: { $exists: false } }],
    });
    deletedNull = r.deletedCount || 0;
  } catch (err) {
    errors += 1;
    logger.warn(`[ghost cleanup] null-executionId sweep failed: ${err.message}`);
  }

  // Pass 2 — unverified stubs past grace window. Only stubs (source != initiate)
  // can be ghost-expired; initiate rows are always trusted because we got the
  // executionId straight from Bolna POST /call.
  try {
    const stubCutoff = new Date(Date.now() - STUB_GHOST_GRACE_MS);
    const r = await CallRecord.updateMany(
      {
        source: { $in: ['webhook', 'reconciliation', 'legacy'] },
        bolnaVerifiedAt: null,
        status: { $nin: TERMINAL_STATUSES },
        createdAt: { $lte: stubCutoff },
      },
      {
        $set: {
          status: 'expired',
          statusRank: 10,
          statusUpdatedAt: new Date(),
          completedAt: new Date(),
          errorMessage: 'ghost-cleanup: stub never verified against Bolna within grace window',
        },
      }
    );
    expiredStubs = r.modifiedCount || 0;
  } catch (err) {
    errors += 1;
    logger.warn(`[ghost cleanup] stub-expire sweep failed: ${err.message}`);
  }

  // Pass 3 — non-terminal stubs still within grace: probe Bolna once. Mark
  // bolnaVerifiedAt on 200 so they leave the cleanup pool; otherwise leave
  // for the next tick.
  try {
    const candidates = await CallRecord.find({
      source: { $in: ['webhook', 'reconciliation', 'legacy', 'backfill'] },
      bolnaVerifiedAt: null,
      executionId: { $exists: true, $nin: [null, ''] },
      status: { $nin: TERMINAL_STATUSES },
    })
      .select('_id executionId createdAt')
      .limit(GHOST_CLEANUP_BATCH)
      .lean();

    for (const row of candidates) {
      try {
        const verify = await bolnaService.verifyExecutionExistsInBolna(row.executionId);
        if (verify.exists === true) {
          await CallRecord.updateOne(
            { _id: row._id },
            { $set: { bolnaVerifiedAt: new Date() } }
          );
          verifiedStubs += 1;
          continue;
        }
        if (verify.notFound === true) {
          const ageMs = Date.now() - new Date(row.createdAt).getTime();
          if (ageMs >= NOT_FOUND_GHOST_GRACE_MS) {
            await CallRecord.updateOne(
              { _id: row._id, status: { $nin: TERMINAL_STATUSES } },
              {
                $set: {
                  status: 'expired',
                  statusRank: 10,
                  statusUpdatedAt: new Date(),
                  completedAt: new Date(),
                  errorMessage: 'ghost-cleanup: Bolna returned 404 for executionId past grace window',
                },
              }
            );
            expiredNotFound += 1;
          }
        }
      } catch (probeErr) {
        errors += 1;
        logger.warn(
          `[ghost cleanup] verify failed executionId=${row.executionId}: ${probeErr.message}`
        );
      }
    }
  } catch (err) {
    errors += 1;
    logger.warn(`[ghost cleanup] probe sweep failed: ${err.message}`);
  }

  if (deletedNull || expiredStubs || verifiedStubs || expiredNotFound || errors) {
    logger.info(
      `[ghost cleanup] deletedNull=${deletedNull} expiredStubs=${expiredStubs} ` +
        `verified=${verifiedStubs} expiredNotFound=${expiredNotFound} errors=${errors}`
    );
  }

  return { deletedNull, expiredStubs, verifiedStubs, expiredNotFound, errors };
}

export async function runCallHistorySync() {
  try {
    const reconcile = await reconcileStuckRecords();
    const backfill = await backfillFromAgentList();
    const chat = await reconcileChatCalls();
    const ghosts = await cleanupGhostCalls();
    if (
      reconcile.reconciled ||
      backfill.applied ||
      reconcile.errors ||
      backfill.errors ||
      chat.ringExpired ||
      chat.ongoingExpired ||
      ghosts.deletedNull ||
      ghosts.expiredStubs ||
      ghosts.expiredNotFound ||
      ghosts.errors
    ) {
      logger.info(
        `[callSync cron] reconcile=${reconcile.reconciled}/applied=${reconcile.applied}/err=${reconcile.errors} ` +
          `backfill=${backfill.scanned}/applied=${backfill.applied}/err=${backfill.errors} ` +
          `chat=ring${chat.ringExpired}/ongoing${chat.ongoingExpired} ` +
          `ghost=del${ghosts.deletedNull}/expStub${ghosts.expiredStubs}/exp404${ghosts.expiredNotFound}/ver${ghosts.verifiedStubs}`
      );
    }
  } catch (err) {
    logger.error(`[callSync cron] tick failed: ${err.message}`);
  }
}

export function startCallRecordSyncScheduler(intervalMinutes = 1) {
  const intervalMs = Math.max(1, Number(intervalMinutes) || 1) * 60 * 1000;
  // Fire-and-forget initial run; subsequent runs on interval.
  runCallHistorySync();
  const id = setInterval(runCallHistorySync, intervalMs);
  logger.info(`[callSync cron] scheduler started (every ${intervalMinutes} min)`);
  return id;
}

export function stopCallRecordSyncScheduler(id) {
  if (id) {
    clearInterval(id);
    logger.info('[callSync cron] scheduler stopped');
    return true;
  }
  return false;
}
