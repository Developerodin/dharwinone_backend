import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Role from '../models/role.model.js';

/**
 * Requires the authenticated user to have an active role with the given name.
 * Must be used after auth() so req.user is set.
 * @param {string} roleName - e.g. 'Agent', 'Administrator'
 */
const requireRoleByName = (roleName) => async (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
  }
  const roleIds = req.user.roleIds || [];
  if (roleIds.length === 0) {
    return next(
      new ApiError(httpStatus.FORBIDDEN, `This action requires the ${roleName} role`)
    );
  }
  const hasRole = await Role.findOne({ _id: { $in: roleIds }, name: roleName, status: 'active' });
  if (!hasRole) {
    return next(
      new ApiError(httpStatus.FORBIDDEN, `This action requires the ${roleName} role`)
    );
  }
  next();
};

export default requireRoleByName;
