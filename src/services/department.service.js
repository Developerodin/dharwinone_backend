import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Department from '../models/department.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import Employee from '../models/employee.model.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { buildAuditEnvelope, buildUpdateAuditMetadata, pickFieldsUpdated, snapshotDepartment } from '../utils/auditMetadata.helper.js';

const escapeRegex = (v) => String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const canDeactivateDepartment = ({ referencingUnits, assignedEmployees }) => {
  if (referencingUnits > 0 || assignedEmployees > 0) {
    return { ok: false, reason: 'Reassign units/employees before deactivating this department' };
  }
  return { ok: true };
};

export const createDepartment = async (body) => {
  if (await Department.isNameTaken(body.name)) throw new ApiError(httpStatus.BAD_REQUEST, 'Department name already taken');
  const dept = await Department.create(body);
  const fieldsUpdated = pickFieldsUpdated(body, ['name', 'code']);
  return buildAuditEnvelope(dept, {
    action: ActivityActions.DEPARTMENT_CREATE,
    entityType: EntityTypes.DEPARTMENT,
    entityId: String(dept._id),
    metadata: { fieldsUpdated },
    occurredAt: new Date(),
  });
};

export const queryDepartments = async (filter, options) => {
  const { search, ...rest } = filter;
  const mongoFilter = { ...rest };
  if (search?.trim()) mongoFilter.$or = [{ name: { $regex: new RegExp(escapeRegex(search.trim()), 'i') } }];
  return Department.paginate(mongoFilter, options);
};

export const listDepartments = async () =>
  (await Department.find({ isActive: { $ne: false } }).sort({ name: 1 }).lean()).map((d) => ({
    id: String(d._id),
    name: d.name,
    code: d.code ?? '',
    isActive: d.isActive !== false,
  }));

export const getDepartmentById = async (id) => Department.findById(id);

export const updateDepartmentById = async (id, body) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  const before = snapshotDepartment(dept);
  if (body.name && (await Department.isNameTaken(body.name, id))) throw new ApiError(httpStatus.BAD_REQUEST, 'Department name already taken');
  Object.assign(dept, body);
  await dept.save();
  const after = snapshotDepartment(dept);
  const metadata = buildUpdateAuditMetadata(before, after, body, ['name', 'code'], []);
  return buildAuditEnvelope(
    dept,
    metadata
      ? {
          action: ActivityActions.DEPARTMENT_UPDATE,
          entityType: EntityTypes.DEPARTMENT,
          entityId: String(dept._id),
          metadata,
          occurredAt: new Date(),
        }
      : null
  );
};

/** Permanent delete. Blocked while any unit/employee (active or inactive) still references it. */
export const deleteDepartmentById = async (id) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  const referencingUnits = await OrgUnit.countDocuments({ departmentId: id });
  const assignedEmployees = await Employee.countDocuments({ departmentId: id });
  if (referencingUnits > 0 || assignedEmployees > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Reassign units/employees before deleting this department');
  }
  await Department.findByIdAndDelete(id);
  const result = { id: String(id), deleted: true };
  return buildAuditEnvelope(result, {
    action: ActivityActions.DEPARTMENT_DELETE,
    entityType: EntityTypes.DEPARTMENT,
    entityId: String(id),
    metadata: { deleteMode: 'permanent' },
    occurredAt: new Date(),
  });
};

export const reactivateDepartmentById = async (id) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  const statusBefore = dept.isActive !== false ? 'active' : 'inactive';
  dept.isActive = true;
  await dept.save();
  return buildAuditEnvelope(dept, {
    action: ActivityActions.DEPARTMENT_REACTIVATE,
    entityType: EntityTypes.DEPARTMENT,
    entityId: String(dept._id),
    metadata: { statusBefore, statusAfter: 'active' },
    occurredAt: new Date(),
  });
};

export const deactivateDepartmentById = async (id) => {
  const dept = await getDepartmentById(id);
  if (!dept) throw new ApiError(httpStatus.NOT_FOUND, 'Department not found');
  const statusBefore = dept.isActive !== false ? 'active' : 'inactive';
  const referencingUnits = await OrgUnit.countDocuments({ departmentId: id, isActive: { $ne: false } });
  const assignedEmployees = await Employee.countDocuments({ departmentId: id, isActive: { $ne: false } });
  const verdict = canDeactivateDepartment({ referencingUnits, assignedEmployees });
  if (!verdict.ok) throw new ApiError(httpStatus.BAD_REQUEST, verdict.reason);
  dept.isActive = false;
  await dept.save();
  return buildAuditEnvelope(dept, {
    action: ActivityActions.DEPARTMENT_DEACTIVATE,
    entityType: EntityTypes.DEPARTMENT,
    entityId: String(dept._id),
    metadata: { statusBefore, statusAfter: 'inactive' },
    occurredAt: new Date(),
  });
};
