import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as departmentService from '../services/department.service.js';

export const createDepartment = catchAsync(async (req, res) => {
  const dept = await departmentService.createDepartment({ ...req.body, createdBy: req.user?._id ?? null });
  res.status(httpStatus.CREATED).send(dept);
});
export const getDepartments = catchAsync(async (req, res) => {
  if (req.query.all === 'true') return res.send(await departmentService.listDepartments());
  const filter = pick(req.query, ['search', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  res.send(await departmentService.queryDepartments(filter, options));
});
export const updateDepartment = catchAsync(async (req, res) => {
  res.send(await departmentService.updateDepartmentById(req.params.departmentId, req.body));
});
export const deactivateDepartment = catchAsync(async (req, res) => {
  res.send(await departmentService.deactivateDepartmentById(req.params.departmentId));
});
export const reactivateDepartment = catchAsync(async (req, res) => {
  res.send(await departmentService.reactivateDepartmentById(req.params.departmentId));
});
export const deleteDepartment = catchAsync(async (req, res) => {
  res.send(await departmentService.deleteDepartmentById(req.params.departmentId));
});
