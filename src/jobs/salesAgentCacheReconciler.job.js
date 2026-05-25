import { randomUUID } from 'crypto';
import EmployeeDefault from '../models/employee.model.js';
import ReferralAttributionDefault from '../models/referralAttribution.model.js';
import ActivityLogDefault from '../models/activityLog.model.js';
import { currentSalesAgent } from '../services/salesAgentAttribution.service.js';
import { DRIFT_THRESHOLD } from '../constants/salesAgentAttribution.js';
import logger from '../config/logger.js';

export async function runReconciler({
  Employee = EmployeeDefault,
  ReferralAttribution = ReferralAttributionDefault,
  ActivityLog = ActivityLogDefault,
  pageOnCall,
  incrementCounter,
  dryRun = false,
  tenantId = null,
  maxRepairs = Number(process.env.RECONCILER_MAX_REPAIRS) || 500,
} = {}) {
  const reconcilerRunId = randomUUID();
  const baseFilter = {
    $or: [{ currentSalesAgentUserId: { $ne: null } }, { attributionJobId: { $ne: null } }],
  };
  if (tenantId) baseFilter.tenantId = tenantId;

  const cursor = Employee.find(baseFilter).cursor();
  let driftCount = 0;
  let anchorOrphanCount = 0;
  const samples = [];

  for await (const emp of cursor) {
    const expected = await currentSalesAgent(emp._id, emp.attributionJobId, { Model: ReferralAttribution });
    const expectedUserId = expected?.salesAgentUserId ?? null;
    const actualUserId = emp.currentSalesAgentUserId ?? null;
    const expectedJobId = expected ? expected.jobId : null;
    const actualJobId = emp.currentSalesAgentJobId ?? null;
    const drifted =
      String(expectedUserId) !== String(actualUserId) || String(expectedJobId) !== String(actualJobId);

    if (emp.attributionJobId && (!expected || String(expected.jobId) !== String(emp.attributionJobId))) {
      anchorOrphanCount += 1;
      logger.warn({
        event: 'cache_anchor_orphaned',
        employeeId: String(emp._id),
        attributionJobId: String(emp.attributionJobId),
        reconcilerRunId,
      });
    }

    if (!drifted) continue;
    driftCount += 1;
    if (samples.length < 10) {
      samples.push({ employeeId: String(emp._id), expected: expectedUserId, actual: actualUserId });
    }
    if (dryRun) {
      logger.info({
        event: 'cache_drift_dryrun',
        employeeId: emp._id,
        expected: expectedUserId,
        actual: actualUserId,
        reconcilerRunId,
      });
      continue;
    }
    if (driftCount > maxRepairs) {
      logger.error({ event: 'reconciler_aborted_max_repairs', driftCount, maxRepairs, reconcilerRunId });
      pageOnCall?.('referral-cache-reconciler-aborted', { driftCount, maxRepairs, reconcilerRunId });
      return { driftCount, anchorOrphanCount, reconcilerRunId, dryRun, aborted: true };
    }
    await Employee.updateOne(
      { _id: emp._id },
      {
        $set: {
          currentSalesAgentUserId: expectedUserId,
          currentSalesAgentAssignedAt: expected?.assignedAt ?? null,
          currentSalesAgentJobId: expectedJobId,
        },
      }
    );
    if (ActivityLog) {
      await ActivityLog.create({
        actor: null,
        action: 'REFERRAL_CACHE_RECONCILED',
        entityType: 'Employee',
        entityId: String(emp._id),
        metadata: {
          before: { userId: actualUserId, jobId: actualJobId },
          after: { userId: expectedUserId, jobId: expectedJobId },
          reconcilerRunId,
        },
      });
    }
    incrementCounter?.('referral.cache.drift.repaired.total');
    logger.info({ event: 'cache_drift', employeeId: emp._id, expected: expectedUserId, actual: actualUserId, reconcilerRunId });
  }

  if (driftCount >= DRIFT_THRESHOLD.PAGE) {
    pageOnCall?.('referral-cache-drift-high', { driftCount, samples, reconcilerRunId, dryRun });
  } else if (driftCount >= DRIFT_THRESHOLD.WARN) {
    logger.warn({ event: 'cache_drift_warn', driftCount, samples, reconcilerRunId, dryRun });
  }

  return { driftCount, anchorOrphanCount, reconcilerRunId, dryRun };
}
