import { getFeatureFlag } from '../utils/featureFlags.js';

export default function requireFeatureFlag(flagName) {
  return (req, res, next) => {
    const tenantId = req.user?.tenantId;
    if (!getFeatureFlag(tenantId, flagName)) {
      return res.status(404).json({ message: 'Not found' });
    }
    return next();
  };
}
