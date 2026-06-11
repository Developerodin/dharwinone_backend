import httpStatus from 'http-status';
import crypto from 'crypto';
import ApiError from '../utils/ApiError.js';
import OrgScenario, { SCENARIO_STATUSES } from '../models/orgScenario.model.js';
import OrgScenarioUnit from '../models/orgScenarioUnit.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import {
  buildTreeFromData,
  validateOrgUnitPlacement,
  wouldCreateCycle,
} from './orgTree.pure.js';
import * as orgStructureService from './orgStructure.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { buildAuditEnvelope } from '../utils/auditMetadata.helper.js';

const idStr = (v) => (v == null || v === '' ? null : String(v));

const loadScenarioUnits = async (scenarioId) =>
  OrgScenarioUnit.find({ scenarioId }).lean().then((rows) =>
    rows.map((u) => ({
      ...u,
      id: String(u._id),
      parentId: u.parentScenarioUnitId ? String(u.parentScenarioUnitId) : null,
      liveOrgUnitId: u.liveOrgUnitId ? String(u.liveOrgUnitId) : null,
    }))
  );

export const listScenarios = async ({ page = 1, limit = 20, status } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  return OrgScenario.paginate(filter, { page, limit, sortBy: 'updatedAt:desc', lean: true });
};

export const createScenario = async (body, userId) => {
  const scenario = await OrgScenario.create({
    name: body.name,
    notes: body.notes ?? '',
    createdBy: userId ?? null,
  });
  return scenario;
};

/** Clone live org units into a draft scenario. */
export const cloneFromLive = async (scenarioId, userId) => {
  const scenario = await OrgScenario.findById(scenarioId);
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  if (scenario.status !== 'draft') throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft scenarios can be cloned');
  await OrgScenarioUnit.deleteMany({ scenarioId: scenario._id });
  const liveUnits = await OrgUnit.find({ isActive: { $ne: false } }).lean();
  const idMap = new Map();
  const created = [];
  for (const u of liveUnits) {
    const doc = await OrgScenarioUnit.create({
      scenarioId: scenario._id,
      liveOrgUnitId: u._id,
      name: u.name,
      type: u.type,
      departmentId: u.departmentId,
      headEmployeeId: u.headEmployeeId,
      directToCeo: u.directToCeo,
      order: u.order ?? 0,
      isActive: u.isActive !== false,
    });
    idMap.set(String(u._id), doc._id);
    created.push(doc);
  }
  for (const u of liveUnits) {
    const scenarioUnitId = idMap.get(String(u._id));
    const parentLive = u.parentId ? idMap.get(String(u.parentId)) : null;
    if (scenarioUnitId) {
      await OrgScenarioUnit.findByIdAndUpdate(scenarioUnitId, {
        parentScenarioUnitId: parentLive ?? null,
      });
    }
  }
  scenario.clonedAt = new Date();
  scenario.liveVersionAtClone = new Date();
  await scenario.save();
  return { scenario, unitCount: created.length };
};

export const getScenarioTree = async (scenarioId) => {
  const units = await loadScenarioUnits(scenarioId);
  const plain = units.map((u) => ({
    id: u.id,
    name: u.name,
    type: u.type,
    parentId: u.parentId,
    departmentId: u.departmentId ? String(u.departmentId) : null,
    headEmployeeId: u.headEmployeeId ? String(u.headEmployeeId) : null,
    directToCeo: u.directToCeo,
    order: u.order,
    isActive: u.isActive,
    liveOrgUnitId: u.liveOrgUnitId,
  }));
  return buildTreeFromData(plain, []);
};

/** Diff scenario units vs live org by liveOrgUnitId linkage. */
export const diffScenario = async (scenarioId) => {
  const scenario = await OrgScenario.findById(scenarioId).lean();
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  const scenarioUnits = await loadScenarioUnits(scenarioId);
  const liveUnits = await OrgUnit.find().lean();
  const liveById = new Map(liveUnits.map((u) => [String(u._id), u]));
  const changes = [];
  const scenarioLiveIds = new Set(scenarioUnits.map((u) => u.liveOrgUnitId).filter(Boolean));
  for (const su of scenarioUnits) {
    const live = su.liveOrgUnitId ? liveById.get(su.liveOrgUnitId) : null;
    if (!live) {
      changes.push({ kind: 'added', scenarioUnitId: su.id, name: su.name, type: su.type });
      continue;
    }
    const liveParentScenario = su.parentId
      ? scenarioUnits.find((x) => x.id === su.parentId)?.liveOrgUnitId ?? null
      : null;
    const liveParent = live.parentId ? String(live.parentId) : null;
    if (String(liveParentScenario ?? '') !== String(liveParent ?? '')) {
      changes.push({
        kind: 'reparent',
        scenarioUnitId: su.id,
        liveOrgUnitId: su.liveOrgUnitId,
        parentBefore: liveParent,
        parentAfter: liveParentScenario,
      });
    }
    if (su.name !== live.name || su.type !== live.type) {
      changes.push({
        kind: 'update',
        scenarioUnitId: su.id,
        liveOrgUnitId: su.liveOrgUnitId,
        fields: ['name', 'type'].filter((f) => su[f] !== live[f]),
      });
    }
  }
  for (const live of liveUnits) {
    if (!scenarioLiveIds.has(String(live._id)) && live.isActive !== false) {
      changes.push({ kind: 'removed', liveOrgUnitId: String(live._id), name: live.name });
    }
  }
  // Only reparent changes are ever written by applyScenario. Surface that count so the
  // UI can stop overstating what "Apply" will do (added/update/removed are live-drift noise).
  const applicableCount = changes.filter((c) => c.kind === 'reparent' && c.liveOrgUnitId).length;
  return { scenarioId: String(scenarioId), changeCount: changes.length, applicableCount, changes };
};

export const reparentScenarioUnit = async (scenarioId, scenarioUnitId, parentScenarioUnitId) => {
  const scenario = await OrgScenario.findById(scenarioId);
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  if (scenario.status !== 'draft') throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft scenarios can be edited');
  const units = await loadScenarioUnits(scenarioId);
  const unit = units.find((u) => u.id === String(scenarioUnitId));
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario unit not found');
  const parentId = parentScenarioUnitId ? String(parentScenarioUnitId) : null;
  if (parentId && wouldCreateCycle(units.map((u) => ({ id: u.id, parentId: u.parentId })), unit.id, parentId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Reparent would create a cycle');
  }
  // Mirror live reparentOrgUnit: a department reporting straight to the CEO must be
  // directToCeo; moving it under a supervisor clears the flag. Otherwise validation
  // rejects department -> CEO moves that the live chart allows.
  const parent = parentId ? units.find((u) => u.id === parentId) : null;
  const nextDirectToCeo =
    unit.type === 'department'
      ? parent?.type === 'ceo'
        ? true
        : parent
          ? false
          : unit.directToCeo
      : unit.directToCeo;
  const verdict = validateOrgUnitPlacement(units, { ...unit, directToCeo: nextDirectToCeo }, parentId);
  if (!verdict.ok) throw new ApiError(httpStatus.BAD_REQUEST, verdict.reason);
  const update = { parentScenarioUnitId: parentId };
  if (unit.type === 'department') update.directToCeo = nextDirectToCeo;
  await OrgScenarioUnit.findByIdAndUpdate(unit.id, update);
  return getScenarioTree(scenarioId);
};

/** Apply scenario changes to live org with batch audit id. */
export const applyScenario = async (scenarioId, userId) => {
  const scenario = await OrgScenario.findById(scenarioId);
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  if (scenario.status === 'applied') throw new ApiError(httpStatus.BAD_REQUEST, 'Scenario already applied');
  const diff = await diffScenario(scenarioId);
  // Apply writes reparents only; refuse to flip a scenario to "applied" when there is
  // nothing it can actually commit (avoids a no-op apply that silently freezes the draft).
  const reparentChanges = diff.changes.filter((c) => c.kind === 'reparent' && c.liveOrgUnitId);
  if (!reparentChanges.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No applicable reparent changes to apply');
  }
  const scenarioApplyId = crypto.randomUUID();
  const applied = [];
  for (const change of reparentChanges) {
    const envelope = await orgStructureService.reparentOrgUnit(change.liveOrgUnitId, change.parentAfter);
    applied.push({ change, audit: envelope.audit });
  }
  scenario.status = 'applied';
  scenario.appliedAt = new Date();
  scenario.scenarioApplyId = scenarioApplyId;
  await scenario.save();
  return buildAuditEnvelope(scenario, {
    action: ActivityActions.ORG_SCENARIO_APPLY,
    entityType: EntityTypes.ORG_SCENARIO,
    entityId: String(scenario._id),
    metadata: {
      scenarioApplyId,
      changeCount: diff.changes.length,
      appliedCount: applied.length,
      outcome: 'success',
    },
    occurredAt: new Date(),
  });
};

/** Delete a scenario and its sandbox units. Applied scenarios are kept as audit history. */
export const deleteScenario = async (scenarioId) => {
  const scenario = await OrgScenario.findById(scenarioId);
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  if (scenario.status === 'applied') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Applied scenarios are kept as audit history and cannot be deleted');
  }
  await OrgScenarioUnit.deleteMany({ scenarioId: scenario._id });
  await scenario.deleteOne();
  return { id: String(scenario._id), deleted: true };
};

export const approveScenario = async (scenarioId, userId) => {
  const scenario = await OrgScenario.findById(scenarioId);
  if (!scenario) throw new ApiError(httpStatus.NOT_FOUND, 'Scenario not found');
  if (scenario.status !== 'draft') throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft scenarios can be approved');
  scenario.status = 'approved';
  scenario.approvedBy = userId ?? null;
  await scenario.save();
  return scenario;
};
