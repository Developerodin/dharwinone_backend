import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import OrgUnit from '../models/orgUnit.model.js';
import Employee from '../models/employee.model.js';
import Department from '../models/department.model.js';
import {
  buildTreeFromData,
  wouldCreateCycle,
  hasActiveChildren,
  departmentHasAssignedEmployees,
  validateOrgUnitPlacement,
} from './orgTree.pure.js';
import { orgEmployeeScope } from './visibilityScope.service.js';

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

export const buildTree = async (actor = null) => {
  const { filter: empScope } = actor ? await orgEmployeeScope(actor) : { filter: {} };
  const [units, employees] = await Promise.all([loadUnitsPlain(), loadActiveEmployeesPlain(empScope)]);
  const tree = buildTreeFromData(units, employees);
  return attachHeadEmployees(tree);
};

export const listOrgUnits = async () => {
  const units = await loadUnitsPlain();
  const headMap = await loadHeadMap(units.map((u) => u.headEmployeeId).filter(Boolean));
  return units.map((u) => {
    const hid = u.headEmployeeId ? String(u.headEmployeeId) : null;
    return { ...u, headEmployee: hid ? headMap.get(hid) ?? null : null };
  });
};

export const createOrgUnit = async (body, userId) => {
  const units = await loadUnitsPlain();
  assertPlacement(units, body, body.parentId ?? null);
  return OrgUnit.create({ ...body, createdBy: userId ?? null });
};

export const updateOrgUnit = async (id, body) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  const next = {
    type: unit.type,
    departmentId: body.departmentId !== undefined ? body.departmentId : unit.departmentId,
    directToCeo: body.directToCeo !== undefined ? body.directToCeo : unit.directToCeo,
  };
  const units = await loadUnitsPlain();
  assertPlacement(units, next, unit.parentId);
  Object.assign(unit, body);
  await unit.save();
  return unit;
};

export const reparentOrgUnit = async (id, newParentId) => {
  const units = await loadUnitsPlain();
  assertReparentAllowed(units, id, newParentId);
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  assertPlacement(units, unit, newParentId ?? null);
  unit.parentId = newParentId ?? null;
  await unit.save();
  return unit;
};

export const assignHead = async (id, headEmployeeId) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  await assertHeadAssignment(unit, headEmployeeId);
  unit.headEmployeeId = headEmployeeId ?? null;
  await unit.save();
  return unit;
};

export const deactivateOrgUnit = async (id) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
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
  return unit;
};

export const getOrgCoverageSummary = async (actor = null) => {
  const { filter: empScope } = actor ? await orgEmployeeScope(actor) : { filter: {} };
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

  return {
    totalActiveEmployees: employees.length,
    assignedEmployees: employees.length - tree.unassigned.length,
    unassignedEmployees: tree.unassigned.length,
    totalOrgUnits: units.length,
    departmentsWithoutNode,
    departmentNodesWithoutEmployees: deptNodesWithoutEmployees,
    unitsMissingHead,
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

export const exportComplianceReport = async (actor = null) => {
  const tree = await buildTree(actor);
  const summary = await getOrgCoverageSummary(actor);
  return {
    generatedAt: new Date().toISOString(),
    summary,
    hierarchy: flattenTreePaths(tree.roots),
    unassigned: tree.unassigned.map((e) => ({ id: e.id, fullName: e.fullName, email: e.email ?? '' })),
  };
};
