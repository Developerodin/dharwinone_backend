import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import OrgUnit from '../models/orgUnit.model.js';
import Employee from '../models/employee.model.js';
import Department from '../models/department.model.js';
import { countOpenSlots, listVacantSlotsForChart } from './orgSlot.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import {
  buildAuditEnvelope,
  buildUpdateAuditMetadata,
  countDescendantUnits,
  idStr,
  pickFieldsUpdated,
  snapshotOrgUnit,
} from '../utils/auditMetadata.helper.js';
import {
  buildTreeFromData,
  wouldCreateCycle,
  hasActiveChildren,
  departmentHasAssignedEmployees,
  validateOrgUnitPlacement,
  childrenValidAfterTypeChange,
  computeSpanMetrics,
  filterUnitsToSubtree,
  findUnitPathIds,
} from './orgTree.pure.js';
import User from '../models/user.model.js';

const escapeRegex = (v) => String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Owner user ids for active/pending Employee-role users. Read-only — mirrors the
 * scope used by the ATS Employees list (queryCandidates), so the org chart counts
 * the same people. Returns null when the Employee role doesn't exist (= no scoping).
 */
const getEmployeeRoleOwnerIds = async () => {
  const { getRoleByName } = await import('./role.service.js');
  const employeeRole = await getRoleByName('Employee');
  if (!employeeRole?._id) return null;
  const users = await User.find(
    { roleIds: { $in: [employeeRole._id] }, status: { $in: ['active', 'pending'] } },
    { _id: 1 }
  ).lean();
  return users.map((u) => u._id);
};

/** Employee read filter for org surfaces — owner ∈ Employee-role users (matches /ats/employees). */
const employeeScopeFilter = async () => {
  const ownerIds = await getEmployeeRoleOwnerIds();
  if (ownerIds === null) return {};
  return { owner: { $in: ownerIds } };
};

export const assertReparentAllowed = (units, nodeId, newParentId) => {
  if (wouldCreateCycle(units, nodeId, newParentId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That move would create a loop in the org chart');
  }
};

const loadUnitsPlain = async () =>
  (await OrgUnit.find({ isActive: { $ne: false } }).select('name type parentId departmentId headEmployeeId directToCeo order isActive').lean())
    .map((u) => ({ ...u, id: String(u._id) }));

const loadActiveEmployeesPlain = async (scopeFilter = {}) =>
  (await Employee.find({ isActive: { $ne: false }, ...scopeFilter })
    .select('fullName email designation departmentId')
    .lean())
    .map((e) => ({ ...e, id: String(e._id) }));

const loadHeadMap = async (headIds) => {
  const ids = [...new Set((headIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Employee.find({ _id: { $in: ids } })
    .select('fullName email designation departmentId')
    .lean();
  return new Map(rows.map((e) => [String(e._id), { id: String(e._id), fullName: e.fullName, email: e.email, designation: e.designation, departmentId: e.departmentId ? String(e.departmentId) : null }]));
};

const attachHeadEmployees = async (tree) => {
  const headIds = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.headEmployeeId) headIds.push(String(n.headEmployeeId));
      walk(n.children);
    }
  };
  walk(tree.roots);
  const headMap = await loadHeadMap(headIds);
  const decorate = (nodes) => {
    for (const n of nodes || []) {
      const hid = n.headEmployeeId ? String(n.headEmployeeId) : null;
      n.headEmployee = hid ? headMap.get(hid) ?? null : null;
      decorate(n.children);
    }
  };
  decorate(tree.roots);
  return tree;
};

const attachSpanMetrics = (tree, units, employees) => {
  const metrics = computeSpanMetrics(units, employees);
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const m = metrics.get(String(n.id));
      if (m) {
        n.spanDirect = m.directReports;
        n.spanIndirect = m.indirectReports;
        n.spanBand = m.band;
      }
      walk(n.children);
    }
  };
  walk(tree.roots);
  return tree;
};

const attachVacantSlots = async (tree) => {
  const slots = await listVacantSlotsForChart();
  const byUnit = new Map();
  for (const s of slots) {
    if (!s.orgUnitId) continue;
    if (!byUnit.has(s.orgUnitId)) byUnit.set(s.orgUnitId, []);
    byUnit.get(s.orgUnitId).push(s);
  }
  const walk = (nodes) => {
    for (const n of nodes || []) {
      const ghosts = byUnit.get(String(n.id)) || [];
      for (const g of ghosts) {
        n.children = n.children || [];
        n.children.push({
          id: `slot-${g.id}`,
          name: g.titleLabel,
          type: 'department',
          parentId: String(n.id),
          isGhostSlot: true,
          slotId: g.id,
          memberCount: 0,
          children: [],
        });
      }
      walk(n.children);
    }
  };
  walk(tree.roots);
  return tree;
};

export const buildTree = async (actor = null) => {
  const empScope = await employeeScopeFilter();
  const [units, employees] = await Promise.all([loadUnitsPlain(), loadActiveEmployeesPlain(empScope)]);
  const tree = buildTreeFromData(units, employees);
  await attachHeadEmployees(tree);
  const withSpan = attachSpanMetrics(tree, units, employees);
  return attachVacantSlots(withSpan);
};

/** Lazy subtree for chart expansion — rootId null loads top levels only. */
export const buildTreeLazy = async (actor = null, { rootId = null, depth = 2 } = {}) => {
  const empScope = await employeeScopeFilter();
  const [allUnits, employees] = await Promise.all([loadUnitsPlain(), loadActiveEmployeesPlain(empScope)]);
  const units = filterUnitsToSubtree(allUnits, rootId, depth);
  const tree = buildTreeFromData(units, employees);
  await attachHeadEmployees(tree);
  return attachSpanMetrics(tree, allUnits, employees);
};

/** Search org units/employees by name for chart discovery. */
export const searchOrgChart = async (actor = null, q = '') => {
  const query = String(q || '').trim().toLowerCase();
  if (!query || query.length < 2) return { units: [], employees: [], paths: [] };
  const empScope = await employeeScopeFilter();
  const [units, employees] = await Promise.all([loadUnitsPlain(), loadActiveEmployeesPlain(empScope)]);
  const unitHits = units.filter((u) => String(u.name || '').toLowerCase().includes(query)).slice(0, 20);
  const employeeHits = employees
    .filter((e) => String(e.fullName || '').toLowerCase().includes(query))
    .slice(0, 20)
    .map((e) => ({ id: e.id, fullName: e.fullName, departmentId: e.departmentId ? String(e.departmentId) : null }));
  const deptNodeByDeptId = new Map(
    units.filter((u) => u.type === 'department' && u.departmentId).map((u) => [String(u.departmentId), String(u.id)])
  );
  const paths = [];
  for (const u of unitHits) {
    const p = findUnitPathIds(units, u.id);
    if (p) paths.push({ kind: 'unit', id: String(u.id), pathIds: p });
  }
  for (const e of employeeHits) {
    const unitId = e.departmentId ? deptNodeByDeptId.get(e.departmentId) : null;
    if (unitId) {
      const p = findUnitPathIds(units, unitId);
      if (p) paths.push({ kind: 'employee', id: e.id, unitId, pathIds: p });
    }
  }
  return {
    units: unitHits.map((u) => ({ id: String(u.id), name: u.name, type: u.type })),
    employees: employeeHits,
    paths,
  };
};

/** Read-only employee directory for /organization/directory. */
export const queryEmployeeDirectory = async (actor = null, { q, page = 1, limit = 24 } = {}) => {
  const empScope = await employeeScopeFilter();
  const filter = { isActive: { $ne: false }, ...empScope };
  if (q && String(q).trim()) {
    filter.fullName = { $regex: new RegExp(escapeRegex(String(q).trim()), 'i') };
  }
  const result = await Employee.paginate(filter, {
    page,
    limit,
    sortBy: 'fullName:asc',
    lean: true,
    select: 'fullName email designation departmentId',
  });
  const deptIds = [...new Set(result.results.map((e) => e.departmentId).filter(Boolean))];
  const depts = deptIds.length ? await Department.find({ _id: { $in: deptIds } }).select('name').lean() : [];
  const deptMap = new Map(depts.map((d) => [String(d._id), d.name]));
  result.results = result.results.map((e) => ({
    id: String(e._id),
    fullName: e.fullName,
    email: e.email ?? '',
    designation: e.designation ?? '',
    departmentId: e.departmentId ? String(e.departmentId) : null,
    departmentName: e.departmentId ? deptMap.get(String(e.departmentId)) ?? '' : '',
  }));
  return result;
};
const assertPlacement = (units, candidateUnit, parentId) => {
  const verdict = validateOrgUnitPlacement(units, candidateUnit, parentId);
  if (!verdict.ok) throw new ApiError(httpStatus.BAD_REQUEST, verdict.reason);
};

const assertHeadAssignment = async (unit, headEmployeeId) => {
  if (!headEmployeeId) return;
  const emp = await Employee.findById(headEmployeeId).select('fullName departmentId isActive').lean();
  if (!emp || emp.isActive === false) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Selected head employee is not active');
  }
  if (unit.type === 'department' && unit.departmentId) {
    if (String(emp.departmentId || '') !== String(unit.departmentId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Head employee must belong to this department');
    }
  }
};

export const listOrgUnits = async () => {
  const units = await loadUnitsPlain();
  const headMap = await loadHeadMap(units.map((u) => u.headEmployeeId).filter(Boolean));
  return units.map((u) => {
    const hid = u.headEmployeeId ? String(u.headEmployeeId) : null;
    return { ...u, headEmployee: hid ? headMap.get(hid) ?? null : null };
  });
};

/**
 * Paginated + searchable unit list for the Structure table. The full-array
 * listOrgUnits() is kept for the chart and modal/reparent dropdowns, which need
 * the whole tree.
 */
export const queryOrgUnits = async ({ q, page, limit, sortBy, includeInactive = false } = {}) => {
  const filter = {};
  if (!includeInactive) filter.isActive = { $ne: false };
  if (q && String(q).trim()) filter.name = { $regex: new RegExp(escapeRegex(String(q).trim()), 'i') };
  const result = await OrgUnit.paginate(filter, { page, limit, sortBy: sortBy || 'name:asc', lean: true });
  const headMap = await loadHeadMap(result.results.map((u) => u.headEmployeeId).filter(Boolean));
  result.results = result.results.map((u) => {
    const hid = u.headEmployeeId ? String(u.headEmployeeId) : null;
    return { ...u, id: String(u._id), headEmployee: hid ? headMap.get(hid) ?? null : null };
  });
  return result;
};

export const createOrgUnit = async (body, userId) => {
  const units = await loadUnitsPlain();
  assertPlacement(units, body, body.parentId ?? null);
  const unit = await OrgUnit.create({ ...body, createdBy: userId ?? null });
  const fieldsUpdated = pickFieldsUpdated(body, [
    'name',
    'type',
    'parentId',
    'headEmployeeId',
    'departmentId',
    'directToCeo',
    'order',
  ]);
  return buildAuditEnvelope(unit, {
    action: ActivityActions.ORG_UNIT_CREATE,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(unit._id),
    metadata: {
      fieldsUpdated,
      parentIdAfter: idStr(unit.parentId),
      headEmployeeIdAfter: idStr(unit.headEmployeeId),
    },
    occurredAt: new Date(),
  });
};

export const updateOrgUnit = async (id, body) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const before = snapshotOrgUnit(unit);
  const nextType = body.type !== undefined ? body.type : unit.type;
  const typeChanged = nextType !== unit.type;
  // Leaving department type drops the department link unless one is supplied.
  let nextDepartmentId;
  if (body.departmentId !== undefined) nextDepartmentId = body.departmentId;
  else if (nextType !== 'department') nextDepartmentId = null;
  else nextDepartmentId = unit.departmentId;
  const nextParentId = body.parentId !== undefined ? body.parentId ?? null : unit.parentId;
  const next = {
    type: nextType,
    departmentId: nextDepartmentId,
    directToCeo: body.directToCeo !== undefined ? body.directToCeo : unit.directToCeo,
  };
  const units = await loadUnitsPlain();
  if (body.parentId !== undefined && idStr(nextParentId) !== idStr(unit.parentId)) {
    assertReparentAllowed(units, id, nextParentId);
  }
  assertPlacement(units, { ...unit.toObject(), ...next, type: nextType, departmentId: nextDepartmentId }, nextParentId);
  if (typeChanged) {
    const verdict = childrenValidAfterTypeChange(units, id, nextType);
    if (!verdict.ok) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Changing type to "${nextType}" would orphan child unit "${verdict.child.name}". Reassign or move it first.`
      );
    }
  }
  Object.assign(unit, body);
  unit.type = nextType;
  unit.departmentId = nextDepartmentId;
  await unit.save();
  const after = snapshotOrgUnit(unit);
  const allowedFields = ['name', 'type', 'parentId', 'headEmployeeId', 'departmentId', 'directToCeo', 'order'];
  const idFields = ['parentId', 'headEmployeeId', 'departmentId'];
  const metadata = buildUpdateAuditMetadata(before, after, body, allowedFields, idFields);
  return buildAuditEnvelope(
    unit,
    metadata
      ? {
          action: ActivityActions.ORG_UNIT_UPDATE,
          entityType: EntityTypes.ORG_UNIT,
          entityId: String(unit._id),
          metadata,
          occurredAt: new Date(),
        }
      : null
  );
};

export const reactivateOrgUnit = async (id) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const statusBefore = unit.isActive !== false ? 'active' : 'inactive';
  const units = await loadUnitsPlain();
  assertPlacement(units, unit, unit.parentId);
  unit.isActive = true;
  await unit.save();
  return buildAuditEnvelope(unit, {
    action: ActivityActions.ORG_UNIT_REACTIVATE,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(unit._id),
    metadata: { statusBefore, statusAfter: 'active' },
    occurredAt: new Date(),
  });
};

/** Permanent delete. Blocked while any unit (active or inactive) still points here. */
export const deleteOrgUnit = async (id) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const childCount = await OrgUnit.countDocuments({ parentId: id });
  if (childCount > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Remove or reparent child units before deleting this unit');
  }
  await OrgUnit.findByIdAndDelete(id);
  const result = { id: String(id), deleted: true };
  return buildAuditEnvelope(result, {
    action: ActivityActions.ORG_UNIT_DELETE,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(id),
    metadata: { deleteMode: 'permanent' },
    occurredAt: new Date(),
  });
};

export const reparentOrgUnit = async (id, newParentId) => {
  const units = await loadUnitsPlain();
  assertReparentAllowed(units, id, newParentId);
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const parentIdBefore = unit.parentId;
  const parentKey = idStr(newParentId);
  const parent = parentKey ? units.find((u) => idStr(u.id) === parentKey) : null;
  const nextDirectToCeo =
    unit.type === 'department'
      ? parent?.type === 'ceo'
        ? true
        : parent
          ? false
          : unit.directToCeo
      : unit.directToCeo;
  assertPlacement(units, { ...unit.toObject(), directToCeo: nextDirectToCeo }, newParentId ?? null);
  unit.parentId = newParentId ?? null;
  if (unit.type === 'department') unit.directToCeo = nextDirectToCeo;
  await unit.save();
  const affectedUnitCount = countDescendantUnits(units, id);
  return buildAuditEnvelope(unit, {
    action: ActivityActions.ORG_UNIT_REPARENT,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(unit._id),
    metadata: {
      parentIdBefore: idStr(parentIdBefore),
      parentIdAfter: idStr(unit.parentId),
      affectedUnitCount,
    },
    occurredAt: new Date(),
  });
};

export const assignHead = async (id, headEmployeeId) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const headEmployeeIdBefore = unit.headEmployeeId;
  await assertHeadAssignment(unit, headEmployeeId);
  unit.headEmployeeId = headEmployeeId ?? null;
  await unit.save();
  const clearing = headEmployeeId == null || headEmployeeId === '';
  const action = clearing ? ActivityActions.ORG_UNIT_HEAD_CLEAR : ActivityActions.ORG_UNIT_HEAD_ASSIGN;
  return buildAuditEnvelope(unit, {
    action,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(unit._id),
    metadata: {
      headEmployeeIdBefore: idStr(headEmployeeIdBefore),
      headEmployeeIdAfter: idStr(unit.headEmployeeId),
    },
    occurredAt: new Date(),
  });
};

export const deactivateOrgUnit = async (id) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const statusBefore = unit.isActive !== false ? 'active' : 'inactive';
  const units = (await OrgUnit.find().select('parentId isActive').lean()).map((u) => ({ ...u, id: String(u._id) }));
  if (hasActiveChildren(units, id)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Reassign or remove child units before deactivating this unit');
  }
  if (unit.type === 'department' && unit.departmentId) {
    const employees = (await Employee.find({ departmentId: unit.departmentId, isActive: { $ne: false } }).select('_id departmentId isActive').lean())
      .map((e) => ({ ...e, id: String(e._id) }));
    if (departmentHasAssignedEmployees(employees, unit.departmentId)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Reassign assigned employees before deactivating this unit');
    }
  }
  unit.isActive = false;
  await unit.save();
  return buildAuditEnvelope(unit, {
    action: ActivityActions.ORG_UNIT_DEACTIVATE,
    entityType: EntityTypes.ORG_UNIT,
    entityId: String(unit._id),
    metadata: { statusBefore, statusAfter: 'inactive' },
    occurredAt: new Date(),
  });
};

/**
 * Active employees eligible to be assigned as org-unit heads (scoped to the actor).
 * When departmentId is given (department nodes), only that department's members are
 * returned — a department head must belong to that department.
 */
export const listAssignableHeads = async (actor = null, departmentId = null) => {
  const empScope = await employeeScopeFilter();
  const scope = departmentId ? { ...empScope, departmentId } : empScope;
  const employees = await loadActiveEmployeesPlain(scope);
  return employees
    .map((e) => ({ id: e.id, name: e.fullName }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
};

export const getOrgCoverageSummary = async (actor = null) => {
  const empScope = await employeeScopeFilter();
  const [units, employees, departments] = await Promise.all([
    loadUnitsPlain(),
    loadActiveEmployeesPlain(empScope),
    Department.find({ isActive: { $ne: false } }).select('_id name').lean(),
  ]);
  const tree = buildTreeFromData(units, employees);
  const deptIdsWithNodes = new Set(
    units.filter((u) => u.type === 'department' && u.departmentId).map((u) => String(u.departmentId))
  );
  const deptNodesWithoutEmployees = units.filter(
    (u) => u.type === 'department' && u.isActive !== false && (!u.departmentId || !employees.some((e) => String(e.departmentId) === String(u.departmentId)))
  ).length;
  const unitsMissingHead = units.filter((u) => u.type !== 'department' && !u.headEmployeeId).length;
  const departmentsWithoutNode = departments.filter((d) => !deptIdsWithNodes.has(String(d._id))).length;
  const spanMetrics = computeSpanMetrics(units, employees);
  const overSpanUnits = [...spanMetrics.values()].filter((m) => m.band !== 'ok').length;
  const openSlots = await countOpenSlots();

  return {
    totalActiveEmployees: employees.length,
    assignedEmployees: employees.length - tree.unassigned.length,
    unassignedEmployees: tree.unassigned.length,
    totalOrgUnits: units.length,
    departmentsWithoutNode,
    departmentNodesWithoutEmployees: deptNodesWithoutEmployees,
    unitsMissingHead,
    overSpanUnits,
    openSlots,
    hasCeo: units.some((u) => u.type === 'ceo'),
    checklist: {
      hasCeo: units.some((u) => u.type === 'ceo'),
      hasManagers: units.some((u) => u.type === 'manager'),
      hasSupervisors: units.some((u) => u.type === 'supervisor'),
      hasDepartmentNodes: units.some((u) => u.type === 'department'),
      allDepartmentsLinked: departmentsWithoutNode === 0,
      noUnassignedEmployees: tree.unassigned.length === 0,
      allLeadershipHeadsAssigned: unitsMissingHead === 0,
    },
  };
};

const flattenTreePaths = (nodes, prefix = []) => {
  const rows = [];
  for (const n of nodes || []) {
    const path = [...prefix, n.name];
    rows.push({
      unitId: n.id,
      unitName: n.name,
      unitType: n.type,
      hierarchyPath: path.join(' → '),
      memberCount: n.memberCount ?? 0,
      headName: n.headEmployee?.fullName ?? '',
      employees: (n.employees || []).map((e) => e.fullName).join('; '),
    });
    rows.push(...flattenTreePaths(n.children, path));
  }
  return rows;
};

export const exportComplianceReport = async (actor = null, { format = 'json' } = {}) => {
  const tree = await buildTree(actor);
  const summary = await getOrgCoverageSummary(actor);
  const hierarchy = flattenTreePaths(tree.roots);
  const result = {
    generatedAt: new Date().toISOString(),
    summary,
    hierarchy,
    unassigned: tree.unassigned.map((e) => ({ id: e.id, fullName: e.fullName, email: e.email ?? '' })),
  };
  const employeeCount = summary.totalActiveEmployees ?? 0;
  const rowCount = hierarchy.length + (tree.unassigned?.length ?? 0);
  const fmt = String(format || 'json').toLowerCase();
  if (fmt === 'csv') {
    const header = ['unitId', 'unitName', 'unitType', 'hierarchyPath', 'memberCount', 'headName', 'employees'];
    const lines = [header.join(',')];
    for (const row of hierarchy) {
      lines.push(
        [
          row.unitId,
          row.unitName,
          row.unitType,
          row.hierarchyPath,
          row.memberCount,
          row.headName,
          row.employees,
        ]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(',')
      );
    }
    // Lead with a UTF-8 BOM so Excel reads the file as UTF-8 (else "→" and
    // accented names render as mojibake — Excel ignores the HTTP charset).
    result.csv = String.fromCharCode(0xfeff) + lines.join('\n');
  }
  return {
    result,
    audit: {
      action: ActivityActions.ORG_STRUCTURE_EXPORT,
      entityType: EntityTypes.ORG_STRUCTURE,
      entityId: 'compliance-report',
      metadata: {
        format: fmt,
        rowCount,
        employeeCount,
        outcome: 'success',
      },
      occurredAt: new Date(),
    },
  };
};
