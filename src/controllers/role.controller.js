import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as roleService from '../services/role.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const createRole = catchAsync(async (req, res) => {
  const role = await roleService.createRole(req.body);
  await activityLogService.createActivityLog(req.user.id, ActivityActions.ROLE_CREATE, EntityTypes.ROLE, role.id, { name: role.name }, req);
  res.status(httpStatus.CREATED).send(role);
});

const getRoles = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await roleService.queryRoles(filter, options);
  res.send(result);
});

const getRole = catchAsync(async (req, res) => {
  const role = await roleService.getRoleById(req.params.roleId);
  if (!role) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Role not found');
  }
  res.send(role);
});

const updateRole = catchAsync(async (req, res) => {
  const role = await roleService.updateRoleById(req.params.roleId, req.body);
  const metadata = {};
  if (req.body.permissions !== undefined) metadata.permissionsChanged = true;
  if (req.body.status !== undefined) metadata.status = req.body.status;
  await activityLogService.createActivityLog(req.user.id, ActivityActions.ROLE_UPDATE, EntityTypes.ROLE, role.id, Object.keys(metadata).length ? metadata : { name: role.name }, req);
  res.send(role);
});

const deleteRole = catchAsync(async (req, res) => {
  await roleService.deleteRoleById(req.params.roleId);
  await activityLogService.createActivityLog(req.user.id, ActivityActions.ROLE_DELETE, EntityTypes.ROLE, req.params.roleId, {}, req);
  res.status(httpStatus.NO_CONTENT).send();
});

export {
  createRole,
  getRoles,
  getRole,
  updateRole,
  deleteRole,
};
