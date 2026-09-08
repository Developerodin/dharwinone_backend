import { writeAtsAudit } from './atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import logger from '../config/logger.js';
import { createPlacementAuditEvent } from './placementAuditEvent.service.js';

const PA_ACTION_TO_AL = {
  PLACEMENT_STATUS_CHANGED: ActivityActions.PLACEMENT_STATUS_CHANGE,
  PLACEMENT_COMPENSATION_CHANGED: ActivityActions.PLACEMENT_COMPENSATION_CHANGE,
  PREBOARDING_GATE_BYPASSED: ActivityActions.PLACEMENT_PREBOARDING_GATE_BYPASS,
};

/**
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.placementId
 * @param {string} params.action
 * @param {import('mongoose').Types.ObjectId|string|null} params.actorId
 * @param {string|null} [params.fromValue]
 * @param {string|null} [params.toValue]
 * @param {object|null} [params.details]
 */
export const recordPlacementAudit = async ({ placementId, action, actorId, fromValue, toValue, details }) => {
  await createPlacementAuditEvent({ placementId, action, actorId, fromValue, toValue, details });

  const alAction = PA_ACTION_TO_AL[action];
  if (alAction && actorId) {
    writeAtsAudit(
      String(actorId),
      {
        action: alAction,
        entityType: EntityTypes.PLACEMENT,
        entityId: String(placementId),
        metadata: {
          fromValue: fromValue ?? null,
          toValue: toValue ?? null,
          details: details ?? null,
          legacy: { placementAuditAction: action },
        },
      },
      null,
      { editContext: { staffEdit: true } }
    ).catch((err) => logger.warn({ err, action }, 'placement_audit_al_mirror_failed'));
  }
};

export { listAuditForPlacement } from './placementAuditEvent.service.js';
