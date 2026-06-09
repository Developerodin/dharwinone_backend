import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getGrantingPermissions } from '../config/permissions.js';
import { persistDeniedOrgMutateAudit } from '../services/activityLog.service.js';
import { EntityTypes } from '../config/activityLog.js';

const isAuditOnDenyOptions = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && v.auditOnDeny === 'org.mutate.denied';

const parseRequirePermissionsArgs = (args) => {
  let auditOnDeny = null;
  const requiredPermissions = [...args];
  const last = requiredPermissions[requiredPermissions.length - 1];
  if (isAuditOnDenyOptions(last)) {
    auditOnDeny = requiredPermissions.pop();
  }
  return { requiredPermissions, auditOnDeny };
};

const deniedTargetFromReq = (req, auditOnDeny) => {
  const entityType =
    auditOnDeny?.targetEntityType ||
    (req.params?.orgUnitId ? EntityTypes.ORG_UNIT : req.params?.departmentId ? EntityTypes.DEPARTMENT : EntityTypes.ORG_STRUCTURE);
  const entityId =
    auditOnDeny?.targetEntityId ||
    req.params?.orgUnitId ||
    req.params?.departmentId ||
    'unknown';
  return { targetEntityType: entityType, targetEntityId: String(entityId) };
};

/**
 * Require one or more permissions for the current request.
 * - Must be used after auth() so req.user and req.authContext are set.
 * - Each required permission is resolved to a list of "granting" permissions (aliases);
 *   the user must have at least one of them (e.g. activityLogs.read is granted by activity.read).
 * - Optional trailing `{ auditOnDeny: 'org.mutate.denied' }` emits allowlisted denied audit row.
 *
 * @param  {...(string|{ auditOnDeny: 'org.mutate.denied', targetEntityType?: string, targetEntityId?: string })} requiredPermissions
 */
const requirePermissions = (...args) => {
  const { requiredPermissions, auditOnDeny } = parseRequirePermissionsArgs(args);
  return async (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }

    if (req.user.platformSuperUser) {
      return next();
    }

    const { permissions } = req.authContext;

    if (!requiredPermissions.length) {
      return next();
    }

    for (const required of requiredPermissions) {
      const granting = getGrantingPermissions(required);
      const hasAccess = granting.some((p) => permissions.has(p));
      if (!hasAccess) {
        if (auditOnDeny?.auditOnDeny === 'org.mutate.denied') {
          const target = deniedTargetFromReq(req, auditOnDeny);
          await persistDeniedOrgMutateAudit(req, required, target);
        }
        return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
      }
    }

    return next();
  };
};

/**
 * User must have at least one of the permissions (each resolved via getGrantingPermissions).
 */
export const requireAnyOfPermissions =
  (...requiredPermissions) =>
  (req, res, next) => {
    if (!req.user || !req.authContext) {
      return next(new ApiError(httpStatus.UNAUTHORIZED, 'Please authenticate'));
    }

    if (req.user.platformSuperUser) {
      return next();
    }

    const { permissions } = req.authContext;

    if (!requiredPermissions.length) {
      return next();
    }

    const ok = requiredPermissions.some((required) => {
      const granting = getGrantingPermissions(required);
      return granting.some((p) => permissions.has(p));
    });

    if (!ok) {
      return next(new ApiError(httpStatus.FORBIDDEN, 'You do not have permission to perform this action'));
    }

    return next();
  };

export default requirePermissions;

