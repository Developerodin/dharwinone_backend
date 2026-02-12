import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Role from '../models/role.model.js';

/**
 * Requires the authenticated user to have a role (by roleIds) with name "Administrator".
 * Must be used after auth() middleware so req.user is set.
 * @param {string} roleName - Role name to require (default 'Administrator')
 */
const requireAdministratorRole =
  (roleName = 'Administrator') =>
  async (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }
    const roleIds = req.user.roleIds || [];
    if (roleIds.length === 0) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'Only users with Administrator role can perform this action'));
    }
    const hasRole = await Role.findOne({ _id: { $in: roleIds }, name: roleName, status: 'active' });
    if (!hasRole) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'Only users with Administrator role can perform this action'));
    }
    next();
  };

export default requireAdministratorRole;
