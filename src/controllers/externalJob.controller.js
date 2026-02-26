import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import pick from '../utils/pick.js';
import externalJobService from '../services/externalJob.service.js';

const search = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const body = req.body || {};
  const source = body.source || 'active-jobs-db';
  if (!['active-jobs-db', 'linkedin-jobs-api'].includes(source)) {
    return res.status(httpStatus.BAD_REQUEST).send({ message: 'Invalid source. Use active-jobs-db or linkedin-jobs-api.' });
  }
  const filters = {
    job_title: body.job_title || '',
    job_location: body.job_location || '',
    offset: body.offset ?? 0,
    date_posted: body.date_posted || '24h',
    remote: body.remote,
  };
  const jobs = await externalJobService.searchFromAPI(filters, source, userId);
  res.send({ jobs, total: jobs.length, hasMore: jobs.length >= 10 });
});

const save = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const job = await externalJobService.saveJob(userId, req.body);
  res.status(httpStatus.OK).send(job);
});

const listSaved = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const options = pick(req.query, ['limit', 'page']);
  const result = await externalJobService.getSavedJobs(userId, options);
  res.send(result);
});

const unsave = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const { externalId } = req.params;
  const source = req.query.source;
  await externalJobService.unsaveJob(userId, externalId, source);
  res.status(httpStatus.NO_CONTENT).send();
});

export default {
  search,
  save,
  listSaved,
  unsave,
};
