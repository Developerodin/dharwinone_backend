import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { AUTO_FETCH_SOURCES } from '../models/externalJobAutoFetchConfig.model.js';
import ExternalJobSyncRun from '../models/externalJobSyncRun.model.js';
import { getOrCreateConfig, runAutoFetchSync, buildQueries } from '../services/externalJobAutoFetch.service.js';
import logger from '../config/logger.js';

const FREQUENCY_MINUTES = [60, 360, 720, 1440];
const POSTED_RANGES = ['24h', '7d'];

function nextRunEstimate(config) {
  if (!config.enabled) return null;
  if (!config.lastRunAt) return new Date().toISOString();
  return new Date(new Date(config.lastRunAt).getTime() + config.frequencyMinutes * 60 * 1000).toISOString();
}

async function withLastRun(config) {
  const lastRun = await ExternalJobSyncRun.findOne({ configId: config._id }).sort({ createdAt: -1 }).lean();
  return {
    ...config.toJSON(),
    queryCount: buildQueries(config).length,
    nextRunAt: nextRunEstimate(config),
    lastRun: lastRun
      ? {
          status: lastRun.status,
          trigger: lastRun.trigger,
          startedAt: lastRun.startedAt,
          completedAt: lastRun.completedAt,
          stats: lastRun.stats,
          errorMessage: lastRun.errorMessage,
          currentQuery: lastRun.currentQuery || null,
          fetchedJobs: lastRun.fetchedJobs || [],
        }
      : null,
  };
}

const MAX_TERMS = 50;
const MAX_TERM_LENGTH = 100;

/**
 * `undefined` means "not supplied" (PATCH leaves the field alone, POST clears it).
 * Anything supplied but not an array is rejected rather than silently treated as
 * "not supplied", which on POST would have wiped the saved list.
 */
function sanitizeStringArray(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${field} must be an array of strings.`);
  }
  const cleaned = value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (cleaned.some((v) => v.length > MAX_TERM_LENGTH)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Each ${field} entry must be ${MAX_TERM_LENGTH} characters or fewer.`);
  }
  const unique = [...new Set(cleaned)];
  if (unique.length > MAX_TERMS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `${field} cannot have more than ${MAX_TERMS} entries.`);
  }
  return unique;
}

const getConfig = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const config = await getOrCreateConfig(userId);
  res.send(await withLastRun(config));
});

function applyConfigFields(config, body, { partial }) {
  const titles = sanitizeStringArray(body.titles, 'titles');
  const locations = sanitizeStringArray(body.locations, 'locations');
  if (titles !== undefined) config.titles = titles;
  else if (!partial) config.titles = [];

  if (locations !== undefined) config.locations = locations;
  else if (!partial) config.locations = [];

  if (body.source !== undefined) {
    if (!AUTO_FETCH_SOURCES.includes(body.source)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `source must be one of: ${AUTO_FETCH_SOURCES.join(', ')}`);
    }
    config.source = body.source;
  }
  if (body.postedRange !== undefined) {
    if (!POSTED_RANGES.includes(body.postedRange)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `postedRange must be one of: ${POSTED_RANGES.join(', ')}`);
    }
    config.postedRange = body.postedRange;
  }
  if (body.remoteOnly !== undefined) config.remoteOnly = Boolean(body.remoteOnly);
  if (body.frequencyMinutes !== undefined) {
    if (!FREQUENCY_MINUTES.includes(Number(body.frequencyMinutes))) {
      throw new ApiError(httpStatus.BAD_REQUEST, `frequencyMinutes must be one of: ${FREQUENCY_MINUTES.join(', ')}`);
    }
    config.frequencyMinutes = Number(body.frequencyMinutes);
  }
  if (body.enabled !== undefined) config.enabled = Boolean(body.enabled);
}

const saveConfig = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const config = await getOrCreateConfig(userId);
  applyConfigFields(config, req.body || {}, { partial: false });
  await config.save();
  res.send(await withLastRun(config));
});

const patchConfig = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const config = await getOrCreateConfig(userId);
  applyConfigFields(config, req.body || {}, { partial: true });
  await config.save();
  res.send(await withLastRun(config));
});

const runNow = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const config = await getOrCreateConfig(userId);
  const queries = buildQueries(config);
  if (queries.length === 0 || (config.titles.length === 0 && config.locations.length === 0)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Add at least one job title or location before running a fetch.');
  }
  // Fire-and-forget: a full run can take minutes once rate-limit throttling
  // spaces out multiple title/location queries. The frontend polls GET
  // /auto-fetch/runs for status instead of holding this request open.
  runAutoFetchSync(config, 'manual').catch((err) => {
    logger.error(`[auto-fetch] manual run failed: ${err.message}`);
  });
  res.status(httpStatus.ACCEPTED).send({ message: 'Sync started', queryCount: queries.length });
});

const listRuns = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id;
  const config = await getOrCreateConfig(userId);
  const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 10, 1), 50);
  const runs = await ExternalJobSyncRun.find({ configId: config._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.send({ runs });
});

export default {
  getConfig,
  saveConfig,
  patchConfig,
  runNow,
  listRuns,
};
