import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import OrgSlot from '../models/orgSlot.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { buildAuditEnvelope } from '../utils/auditMetadata.helper.js';

export const listOrgSlots = async ({ orgUnitId, status, page = 1, limit = 50 } = {}) => {
  const filter = {};
  if (orgUnitId) filter.orgUnitId = orgUnitId;
  if (status) filter.status = status;
  return OrgSlot.paginate(filter, { page, limit, sortBy: 'createdAt:desc', lean: true });
};

export const createOrgSlot = async (body, userId) => {
  const unit = await OrgUnit.findById(body.orgUnitId);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const slot = await OrgSlot.create({
    orgUnitId: body.orgUnitId,
    positionTitleId: body.positionTitleId ?? null,
    titleLabel: body.titleLabel ?? '',
    status: body.status ?? 'vacant',
    employeeId: body.employeeId ?? null,
    createdBy: userId ?? null,
  });
  return buildAuditEnvelope(slot, {
    action: ActivityActions.ORG_SLOT_CREATE,
    entityType: EntityTypes.ORG_SLOT,
    entityId: String(slot._id),
    metadata: {
      orgUnitId: String(slot.orgUnitId),
      status: slot.status,
      outcome: 'success',
    },
    occurredAt: new Date(),
  });
};

export const updateOrgSlot = async (slotId, body) => {
  const slot = await OrgSlot.findById(slotId);
  if (!slot) throw new ApiError(httpStatus.NOT_FOUND, 'Org slot not found');
  const before = { status: slot.status, employeeId: slot.employeeId ? String(slot.employeeId) : null };
  if (body.status !== undefined) slot.status = body.status;
  if (body.employeeId !== undefined) slot.employeeId = body.employeeId;
  if (body.titleLabel !== undefined) slot.titleLabel = body.titleLabel;
  await slot.save();
  return buildAuditEnvelope(slot, {
    action: ActivityActions.ORG_SLOT_UPDATE,
    entityType: EntityTypes.ORG_SLOT,
    entityId: String(slot._id),
    metadata: {
      orgUnitId: String(slot.orgUnitId),
      statusBefore: before.status,
      statusAfter: slot.status,
      employeeIdBefore: before.employeeId,
      employeeIdAfter: slot.employeeId ? String(slot.employeeId) : null,
      outcome: 'success',
    },
    occurredAt: new Date(),
  });
};

export const listVacantSlotsForChart = async () => {
  const slots = await OrgSlot.find({ status: 'vacant' }).populate('orgUnitId', 'name type').lean();
  return slots.map((s) => ({
    id: String(s._id),
    orgUnitId: s.orgUnitId ? String(s.orgUnitId._id ?? s.orgUnitId) : null,
    orgUnitName: s.orgUnitId?.name ?? '',
    titleLabel: s.titleLabel || 'Vacant slot',
    status: s.status,
  }));
};

export const countOpenSlots = async () => OrgSlot.countDocuments({ status: 'vacant' });
