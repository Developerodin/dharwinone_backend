import catchAsync from '../utils/catchAsync.js';
import { resolveFeatureFlag } from '../services/featureFlag.service.js';

const get = catchAsync(async (req, res) => {
  const payload = resolveFeatureFlag(req.params.key, req.user);
  res.set('Cache-Control', 'private, max-age=60');
  res.send(payload);
});

export { get };
