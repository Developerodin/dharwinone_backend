import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Department from '../models/department.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import Employee from '../models/employee.model.js';

const escapeRegex = (v) => String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const canDeactivateDepartment = ({ referencingUnits, assignedEmployees }) => {
  if (referencingUnits > 0 || assignedEmployees > 0) {
    return { ok: false, reason: 'Reassign units/employees before deactivating this department' };
  }
  return { ok: true };
};

export const createDepartment = async (body) => {
  if (await Department.isNameTaken(body.name)) throw new ApiError(httpStatus.BAD_REQUEST, 'Department name already taken');
  return Department.create(body);
};

export const queryDepartments = async (filter, options) => {
  const { search, ...rest } = filter;
  const mongoFilter = { ...rest };
  if (search?.trim()) mongoFilter.$or = [{ name: { $regex: new RegExp(escapeRegex(search.trim()), 'i') } }];
  return Department.paginate(mongoFilter, options);
};

export const listDepartments = async () => Department.find({ isActive: { $ne: false } }).sort({ name: 1 }).lean();

export const getDepartmentById = async (id) => Department.findById(id);

export const updateDepartmentById = async (id, body) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  if (body.name && (await Department.isNameTaken(body.name, id))) throw new ApiError(httpStatus.BAD_REQUEST, 'Department name already taken');
  Object.assign(dept, body);
  await dept.save();
  return dept;
};

export const deactivateDepartmentById = async (id) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  const referencingUnits = await OrgUnit.countDocuments({ departmentId: id, isActive: { $ne: false } });
  const assignedEmployees = await Employee.countDocuments({ departmentId: id, isActive: { $ne: false } });
  const verdict = canDeactivateDepartment({ referencingUnits, assignedEmployees });
  if (!verdict.ok) throw new ApiError(httpStatus.BAD_REQUEST, verdict.reason);
  dept.isActive = false;
  await dept.save();
  return dept;
};
