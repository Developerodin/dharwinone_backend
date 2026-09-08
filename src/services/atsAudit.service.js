/**
 * ATS Audit adapter — ActivityLog is the primary source of truth.
 *
 * INVESTIGATOR PLAYBOOK (quick reference):
 * 1. Start with ActivityLog filtered by entityType + entityId (or actor for user-centric view).
 * 2. Check metadata.selfService vs metadata.staffEdit to distinguish self-service vs staff edits.
 * 3. Field-level history lives in metadata.changes[] (array of { field, from, to } or { field, changed: true }).
 * 4. metadata.source / auditSource shows which UI screen initiated the mutation (x-audit-source header).
 * 5. Legacy mirrors: RecruiterActivityLog (recruiter KPI analytics) and Placement AuditEvent (per-placement API)
 *    may still hold rows for events before cutover — query via GET /recruiter-activity and GET /placements/:id/audit.
 * 6. Failed primary writes land in ActivityLogOutbox — monitor activity_log_write_failed metric.
 * 7. Sensitive reads (document/salary/recording download) use *.download / *.view action keys.
 */
import logger from '../config/logger.js';
import config from '../config/config.js';
import { persistActivityLogFailSoft } from './activityLog.service.js';
import { logActivity } from './recruiterActivity.service.js';
import { createPlacementAuditEvent } from './placementAuditEvent.service.js';
import {
  buildAtsAuditEnvelope,
  buildAtsMetadataBase,
  enrichAtsMetadata,
} from '../utils/atsAudit.helpers.js';

export { buildAtsAuditEnvelope };

/**
 * Persist one canonical ATS audit row (+ optional legacy dual-write). Fail-soft throughout.
 *
 * @param {string} actorId
 * @param {{ audit: { action: string, entityType: string, entityId: string, metadata?: object, occurredAt?: Date|string|null, skipReason?: string }|null }} envelope
 * @param {import('express').Request|null} [req]
 * @param {{ dualWrite?: { recruiterActivity?: boolean, placementAudit?: boolean },
 *           legacy?: { recruiterActivityType?: string, recruiterPayload?: object, placementAudit?: object },
 *           editContext?: { selfService?: boolean, staffEdit?: boolean } }} [options]
 */
export const persistAtsAudit = async (actorId, envelope, req = null, options = {}) => {
  const audit = envelope?.audit;
  if (!audit?.action || !audit.entityType || !audit.entityId) return null;

  const editContext = options.editContext ?? {};
  const baseMeta = buildAtsMetadataBase(req, audit.metadata ?? {});
  const metadata = enrichAtsMetadata(baseMeta, {
    ...editContext,
    changes: audit.metadata?.changes,
  });

  const normalized = {
    audit: {
      ...audit,
      metadata,
      occurredAt: audit.occurredAt ?? new Date(),
    },
  };

  const entry = await persistActivityLogFailSoft(actorId, normalized, req);

  const dualRecruiter =
    options.dualWrite?.recruiterActivity ?? config.atsAudit?.dualWriteRecruiter ?? false;
  const dualPlacement =
    options.dualWrite?.placementAudit ?? config.atsAudit?.dualWritePlacement ?? false;

  if (dualRecruiter && options.legacy?.recruiterActivityType) {
    try {
      await logActivity(actorId, options.legacy.recruiterActivityType, options.legacy.recruiterPayload ?? {});
    } catch (err) {
      logger.warn({ err, action: audit.action }, 'ats_audit_dual_write_recruiter_failed');
    }
  }

  if (dualPlacement && options.legacy?.placementAudit) {
    try {
      await createPlacementAuditEvent(options.legacy.placementAudit);
    } catch (err) {
      logger.warn({ err, action: audit.action }, 'ats_audit_dual_write_placement_failed');
    }
  }

  return entry;
};

/**
 * Convenience: build and persist a simple ATS audit in one call.
 * @param {string} actorId
 * @param {{ action: string, entityType: string, entityId: string, metadata?: object, occurredAt?: Date }} params
 * @param {import('express').Request|null} [req]
 * @param {object} [options]
 */
export const writeAtsAudit = async (actorId, params, req = null, options = {}) =>
  persistAtsAudit(actorId, { audit: params }, req, options);
