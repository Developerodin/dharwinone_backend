import AuditEvent from '../models/auditEvent.model.js';

const TARGET_PLACEMENT = 'Placement';

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
  await AuditEvent.create({
    targetType: TARGET_PLACEMENT,
    targetId: placementId,
    action,
    actor: actorId || null,
    fromValue: fromValue ?? null,
    toValue: toValue ?? null,
    details: details ?? null,
  });
};

/**
 * @param {import('mongoose').Types.ObjectId|string} placementId
 * @returns {Promise<Array>}
 */
export const listAuditForPlacement = async (placementId) => {
  return AuditEvent.find({ targetType: TARGET_PLACEMENT, targetId: placementId })
    .sort({ createdAt: -1 })
    .populate('actor', 'name email')
    .lean();
};
