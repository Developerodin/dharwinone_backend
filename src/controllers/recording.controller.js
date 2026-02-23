import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import recordingService from '../services/recording.service.js';

const listAll = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'limit']);
  const result = await recordingService.listAll(options);
  res.send(result);
});

export { listAll };
