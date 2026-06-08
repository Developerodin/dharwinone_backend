import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Department from '../models/department.model.js';

/** Pure: mutate an employee doc/object to keep departmentId + legacy name string in sync. */
export const applyDepartmentToEmployee = (employee, department) => {
  if (department == null) {
    employee.departmentId = null;
    employee.department = '';
    return employee;
  }
  if (!department._id || !department.name) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid department: _id and name are required');
  }
  employee.departmentId = department._id;
  employee.department = String(department.name);
  return employee;
};

/** DB wrapper: resolve a Department by id then dual-write onto the employee (caller saves). */
export const setEmployeeDepartment = async (employee, departmentId) => {
  if (departmentId == null) return applyDepartmentToEmployee(employee, null);
  const department = await Department.findById(departmentId).select('_id name').lean();
  if (!department) throw new ApiError(httpStatus.BAD_REQUEST, 'Department not found');
  return applyDepartmentToEmployee(employee, department);
};
