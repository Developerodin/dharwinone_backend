import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import OrgUnit from '../models/orgUnit.model.js';
import Employee from '../models/employee.model.js';
import { buildTreeFromData, wouldCreateCycle, hasActiveChildren, departmentHasAssignedEmployees } from './orgTree.pure.js';

export const assertReparentAllowed = (units, nodeId, newParentId) => {
  if (wouldCreateCycle(units, nodeId, newParentId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That move would create a loop in the org chart');
  }
};

const loadUnitsPlain = async () =>
  (await OrgUnit.find().select('name type parentId departmentId headEmployeeId directToCeo order isActive').lean())
    .map((u) => ({ ...u, id: String(u._id) }));

const loadActiveEmployeesPlain = async () =>
  (await Employee.find({ isActive: { $ne: false } }).select('fullName email designation departmentId').lean())
    .map((e) => ({ ...e, id: String(e._id) }));

export const buildTree = async () => {
  const [units, employees] = await Promise.all([loadUnitsPlain(), loadActiveEmployeesPlain()]);
  return buildTreeFromData(units, employees);
};

export const listOrgUnits = async () => loadUnitsPlain();

export const createOrgUnit = async (body, userId) => OrgUnit.create({ ...body, createdBy: userId ?? null });

export const updateOrgUnit = async (id, body) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  Object.assign(unit, body);
  await unit.save();
  return unit;
};

export const reparentOrgUnit = async (id, newParentId) => {
  const units = await loadUnitsPlain();
  assertReparentAllowed(units, id, newParentId);
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
  unit.parentId = newParentId ?? null;
  await unit.save();
  return unit;
};

export const assignHead = async (id, headEmployeeId) => {
  const unit = await OrgUnit.findById(id);
  if (!unit) throw new ApiError(httpStatus.NOT_FOUND, 'Org unit not found');
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
