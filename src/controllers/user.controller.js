import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as userService from '../services/user.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import config from '../config/config.js';
import { userIsAdmin, userIsAgent, validateRoleIdsForAgent } from '../utils/roleHelpers.js';
import { pickUserDisplayForActivityLog, buildUserDeleteActivityMetadata } from '../utils/activityLogSubject.util.js';

const PRIVILEGED_USER_FIELDS = ['platformSuperUser', 'hideFromDirectory'];

const createUser = catchAsync(async (req, res) => {
  const body = { ...req.body };
  if (!req.user?.platformSuperUser) {
    for (const k of PRIVILEGED_USER_FIELDS) delete body[k];
  }
  const user = await userService.createUser(body, {
    allowPrivilegedUserFields: !!req.user?.platformSuperUser,
  });
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.USER_CREATE,
    EntityTypes.USER,
    user.id,
    { roleIds: user.roleIds, ...pickUserDisplayForActivityLog(user) },
    req
  );
  res.status(httpStatus.CREATED).send(user);
});

const getUsers = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'status', 'search', 'role']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.queryUsers(filter, options, req.user);
  res.send(result);
});

const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdForRequester(req.params.userId, req.user);
  res.send(user);
});

const updateUser = catchAsync(async (req, res) => {
  const target = await userService.getUserById(req.params.userId);
  if (!target) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  const self =
    String(req.user.id || req.user._id) === String(target._id);
  if (
    !self &&
    (target.hideFromDirectory || target.platformSuperUser) &&
    !req.user?.platformSuperUser
  ) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  const updateBody = { ...req.body };
  if (!req.user?.platformSuperUser) {
    for (const k of PRIVILEGED_USER_FIELDS) delete updateBody[k];
  }
  const isAdmin = await userIsAdmin(req.user);
  const isAgent = await userIsAgent(req.user);
  if (!isAdmin && 'username' in updateBody) {
    delete updateBody.username;
  }
  const canSetHrmDeviceId =
    !!req.user?.platformSuperUser || config.isDesignatedSuperadminEmail(req.user?.email);
  if (!canSetHrmDeviceId && 'hrmDeviceId' in updateBody) {
    delete updateBody.hrmDeviceId;
  }
  if (isAgent && !isAdmin && Array.isArray(updateBody.roleIds)) {
    const validation = await validateRoleIdsForAgent(updateBody.roleIds);
    if (!validation.allowed) {
      throw new ApiError(
        httpStatus.FORBIDDEN,
        `Agents cannot assign the following roles: ${validation.restrictedNames.join(', ')}. Only Employee, Student, and Mentor are allowed.`
      );
    }
  }
  const previousStatus = target.status;
  const user = await userService.updateUserById(req.params.userId, updateBody);
  const metadata = { ...pickUserDisplayForActivityLog(user) };
  if (req.body.status !== undefined) {
    metadata.field = 'status';
    metadata.newValue = req.body.status;
  }
  const action =
    req.body.status === 'disabled' || req.body.status === 'deleted'
      ? ActivityActions.USER_DISABLE
      : ActivityActions.USER_UPDATE;
  await activityLogService.createActivityLog(req.user.id, action, EntityTypes.USER, user.id, metadata, req);
  if (updateBody.status === 'active' && previousStatus === 'pending') {
    const { tryLogReferralCandidateActivated } = await import('../services/referralAudit.service.js');
    await tryLogReferralCandidateActivated({ userId: user._id || user.id, actorId: req.user.id, req });
  }
  res.send(user);
});

const deleteUser = catchAsync(async (req, res) => {
  const target = await userService.getUserById(req.params.userId);
  if (!target) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  const self =
    String(req.user.id || req.user._id) === String(target._id);
  if (
    !self &&
    (target.hideFromDirectory || target.platformSuperUser) &&
    !req.user?.platformSuperUser
  ) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  if (target.platformSuperUser) {
    const n = await userService.countPlatformSuperUsers();
    if (n <= 1) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete the last platform super user account');
    }
  }
  const deleteAuditMetadata = buildUserDeleteActivityMetadata(target);
  const auditEntry = await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.USER_DELETE,
    EntityTypes.USER,
    req.params.userId,
    deleteAuditMetadata,
    req
  );
  if (!auditEntry) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Could not record the deletion in the audit log; the user was not deleted.'
    );
  }
  await userService.deleteUserById(req.params.userId);
  res.status(httpStatus.NO_CONTENT).send();
});

export {
  createUser,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
};

