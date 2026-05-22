/**
 * Tenant Resolver Middleware (P3)
 *
 * Attaches req.tenantId to every authenticated request.
 *
 * Resolution priority:
 *   1. req.user.tenantId if set (migrated users with explicit tenant).
 *   2. req.user.adminId  if set (platform admins act as their own tenant root;
 *      non-admin users have adminId pointing to their admin).
 *   3. req.user._id      for platform super-users / legacy admin accounts that
 *      have no adminId (they ARE the tenant root).
 *
 * The middleware is non-blocking: if the user is not authenticated it skips
 * silently so it can be applied globally without conflicting with public routes.
 * Authenticated routes that require a tenant should call requireTenant() after
 * this middleware.
 */

import mongoose from 'mongoose';

/**
 * Attach req.tenantId from the authenticated user.
 * Safe to use on all routes — no-ops if req.user is absent.
 */
const tenantResolver = (req, _res, next) => {
  if (!req.user) {
    return next();
  }

  const user = req.user;

  // Priority 1: explicit tenantId field (P3 migrated users)
  if (user.tenantId) {
    req.tenantId = user.tenantId;
    return next();
  }

  // Priority 2: adminId (non-admin users point to their admin, admin users have no adminId)
  if (user.adminId) {
    req.tenantId = user.adminId;
    return next();
  }

  // Priority 3: the user is the tenant root (platform super user / admin account)
  if (user._id || user.id) {
    req.tenantId = user._id || new mongoose.Types.ObjectId(user.id);
    return next();
  }

  next();
};

/**
 * Guard middleware: rejects the request if req.tenantId was not resolved.
 * Use AFTER tenantResolver() on routes that must be tenant-scoped.
 */
const requireTenant = (req, res, next) => {
  if (!req.tenantId) {
    return res.status(403).json({
      code: 403,
      message: 'Tenant context required',
    });
  }
  next();
};

/**
 * Returns a Mongoose filter object scoped to the current request's tenant.
 * Use in service/query layers that have access to req.
 *
 * @param {import('express').Request} req
 * @returns {{ tenantId: mongoose.Types.ObjectId } | {}}
 */
const tenantScope = (req) => {
  if (!req || !req.tenantId) return {};
  return { tenantId: req.tenantId };
};

export { tenantResolver, requireTenant, tenantScope };
export default tenantResolver;
