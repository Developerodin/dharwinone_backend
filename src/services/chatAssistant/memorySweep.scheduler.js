// uat.dharwin.backend/src/services/chatAssistant/memorySweep.scheduler.js
//
// Daily sweep that drops dangling ConversationMemory.lastEntities references.
// rehydrateLastEntities (chatAssistant.service.js) already filters dead refs
// at READ time so the chatbot never surfaces a ghost; this sweep is the
// belt-and-suspenders write-side cleanup so the DB stays tidy and disk
// usage doesn't accumulate forever.
//
// What it does, per ConversationMemory row:
//   - personUserId    -> unset if no active User row
//   - personEmpDocId  -> unset if no Employee row
//   - roleId          -> unset if no active Role row
//   - jobId           -> unset if no Job row
// Conversation summary, turnCount, and lastListing pagination are left alone
// — only entity pointers are scrubbed.

import logger from '../../config/logger.js';
import ConversationMemory from '../../models/conversationMemory.model.js';
import User from '../../models/user.model.js';
import Employee from '../../models/employee.model.js';
import Role from '../../models/role.model.js';
import Job from '../../models/job.model.js';

const DEFAULT_INTERVAL_HOURS = 24;
const BATCH_SIZE = 500;

let intervalId = null;
let inflight = false;

async function liveIdSet(Model, ids, extraFilter = {}) {
  if (!ids.length) return new Set();
  const docs = await Model.find(
    { _id: { $in: ids }, ...extraFilter },
    { _id: 1 }
  ).lean();
  return new Set(docs.map((d) => String(d._id)));
}

export async function runMemorySweep({ batchSize = BATCH_SIZE } = {}) {
  if (inflight) {
    logger.info('[memorySweep] previous run still in flight - skipping');
    return { skipped: true };
  }
  inflight = true;
  const stats = { rowsScanned: 0, rowsTouched: 0, fieldsCleared: 0 };
  try {
    let lastId = null;
    while (true) {
      const cursor = lastId ? { _id: { $gt: lastId } } : {};
      const rows = await ConversationMemory.find(
        cursor,
        { _id: 1, lastEntities: 1, lastListing: 1 }
      ).sort({ _id: 1 }).limit(batchSize).lean();
      if (!rows.length) break;

      const personUserIds = [];
      const personEmpDocIds = [];
      const roleIds = [];
      const jobIds = [];
      for (const r of rows) {
        const le = r.lastEntities || {};
        if (le.personUserId)   personUserIds.push(le.personUserId);
        if (le.personEmpDocId) personEmpDocIds.push(le.personEmpDocId);
        if (le.roleId)         roleIds.push(le.roleId);
        if (le.jobId)          jobIds.push(le.jobId);
        if (r.lastListing?.roleId) roleIds.push(r.lastListing.roleId);
      }

      const [liveUsers, liveEmps, liveRoles, liveJobs] = await Promise.all([
        liveIdSet(User, personUserIds, { status: 'active' }),
        liveIdSet(Employee, personEmpDocIds),
        liveIdSet(Role, roleIds, { status: 'active' }),
        liveIdSet(Job, jobIds),
      ]);

      const ops = [];
      for (const r of rows) {
        const le = r.lastEntities || {};
        const $set = {};
        if (le.personUserId && !liveUsers.has(String(le.personUserId))) {
          $set['lastEntities.personUserId'] = null;
          $set['lastEntities.person'] = null;
          $set['lastEntities.email'] = null;
          stats.fieldsCleared += 1;
        }
        if (le.personEmpDocId && !liveEmps.has(String(le.personEmpDocId))) {
          $set['lastEntities.personEmpDocId'] = null;
          $set['lastEntities.employeeId'] = null;
          stats.fieldsCleared += 1;
        }
        if (le.roleId && !liveRoles.has(String(le.roleId))) {
          $set['lastEntities.roleId'] = null;
          $set['lastEntities.roleSlug'] = null;
          $set['lastEntities.role'] = null;
          stats.fieldsCleared += 1;
        }
        if (le.jobId && !liveJobs.has(String(le.jobId))) {
          $set['lastEntities.jobId'] = null;
          $set['lastEntities.jobTitle'] = null;
          stats.fieldsCleared += 1;
        }
        if (r.lastListing?.roleId && !liveRoles.has(String(r.lastListing.roleId))) {
          $set['lastListing.roleId'] = null;
          $set['lastListing.role'] = null;
          $set['lastListing.cursor'] = null;
          stats.fieldsCleared += 1;
        }
        if (Object.keys($set).length) {
          ops.push({ updateOne: { filter: { _id: r._id }, update: { $set } } });
          stats.rowsTouched += 1;
        }
      }
      if (ops.length) {
        await ConversationMemory.bulkWrite(ops, { ordered: false });
      }
      stats.rowsScanned += rows.length;
      lastId = rows[rows.length - 1]._id;
      if (rows.length < batchSize) break;
    }
    logger.info(
      `[memorySweep] scanned=${stats.rowsScanned} touched=${stats.rowsTouched} fieldsCleared=${stats.fieldsCleared}`
    );
    return stats;
  } catch (err) {
    logger.warn(`[memorySweep] failed: ${err.message}`);
    return { ...stats, error: err.message };
  } finally {
    inflight = false;
  }
}

export function startMemorySweepScheduler({ intervalHours = DEFAULT_INTERVAL_HOURS, runOnStart = false } = {}) {
  if (intervalId) return;
  const ms = Math.max(1, Number(intervalHours)) * 60 * 60 * 1000;
  if (runOnStart) {
    runMemorySweep().catch((err) => logger.warn(`[memorySweep] initial run error: ${err.message}`));
  }
  intervalId = setInterval(() => {
    runMemorySweep().catch((err) => logger.warn(`[memorySweep] tick error: ${err.message}`));
  }, ms);
  logger.info(`[memorySweep] scheduler started (every ${intervalHours}h)`);
}

export function stopMemorySweepScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[memorySweep] scheduler stopped');
  }
}
