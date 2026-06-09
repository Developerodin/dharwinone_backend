import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as departmentService from '../services/department.service.js';
import { persistActivityLogFailSoft } from '../services/activityLog.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id);

const persistEnvelope = async (req, envelope) => {
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  return envelope.result;
};

export const createDepartment = catchAsync(async (req, res) => {
  const envelope = await departmentService.createDepartment({ ...req.body, createdBy: req.user?._id ?? null });
  const result = await persistEnvelope(req, envelope);
  res.status(httpStatus.CREATED).send(result);
});
export const getDepartments = catchAsync(async (req, res) => {
  if (req.query.all === 'true') return res.send(await departmentService.listDepartments());
  const filter = pick(req.query, ['search', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  res.send(await departmentService.queryDepartments(filter, options));
});
export const updateDepartment = catchAsync(async (req, res) => {
  const envelope = await departmentService.updateDepartmentById(req.params.departmentId, req.body);
  res.send(await persistEnvelope(req, envelope));
});
export const deactivateDepartment = catchAsync(async (req, res) => {
  const envelope = await departmentService.deactivateDepartmentById(req.params.departmentId);
  res.send(await persistEnvelope(req, envelope));
});
export const reactivateDepartment = catchAsync(async (req, res) => {
  const envelope = await departmentService.reactivateDepartmentById(req.params.departmentId);
  res.send(await persistEnvelope(req, envelope));
});
export const deleteDepartment = catchAsync(async (req, res) => {
  const envelope = await departmentService.deleteDepartmentById(req.params.departmentId);
  res.send(await persistEnvelope(req, envelope));
});
