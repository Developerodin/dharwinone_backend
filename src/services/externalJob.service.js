import httpStatus from 'http-status';
import ExternalJob from '../models/externalJob.model.js';
import Job from '../models/job.model.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { syncPublishedJobForExternal, archivePublishedJobIfOrphaned } from './externalJobPublishedJob.service.js';
import { resolveLocationMeta } from '../utils/jobLocation.util.js';

const SOURCES = {
  'active-jobs-db': {
    host: 'active-jobs-db.p.rapidapi.com',
    path: '/active-ats',
  },
  'linkedin-job-search-api': {
    host: 'linkedin-job-search-api.p.rapidapi.com',
    endpoints: { '24h': '/active-jb-24h', '7d': '/active-jb-7d' },
  },
};

const LEGACY_SOURCE_ALIASES = {
  'linkedin-jobs-api': 'linkedin-job-search-api',
};

function normalizeSource(source) {
  return LEGACY_SOURCE_ALIASES[source] || source;
}

const RATE_LIMIT_REQUESTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const requestCounts = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  let entry = requestCounts.get(userId);
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    requestCounts.set(userId, entry);
  }
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_REQUESTS) {
    throw new ApiError(httpStatus.TOO_MANY_REQUESTS, 'Too many requests. Please wait a minute before searching again.');
  }
}

function extractLinkedInJobId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const path = u.pathname || '';
    const m = path.match(/\/jobs\/view\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function mapRowToJob(row, sourceKey) {
  const id = row.id != null ? String(row.id) : '';
  const url = row.url || '';
  const jobId = url ? extractLinkedInJobId(url) : null;
  const jobIdUnique = jobId || `ext_${id}`;

  let location = '';
  let locationMeta;
  const loc = row.locations_derived;
  if (Array.isArray(loc) && loc.length > 0) {
    const parts = loc
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') {
          const arr = [x.city, x.admin, x.country].filter(Boolean);
          return arr.join(', ');
        }
        return '';
      })
      .filter(Boolean);
    // Feeds list every site of one posting; source sites render "City +N more".
    location = parts.length > 1 ? `${parts[0]} +${parts.length - 1} more` : parts[0] || '';
    // Resolve from the clean first location, not the "+N more" display string --
    // the suffix has no comma before it and pollutes the trailing country segment.
    if (parts[0]) locationMeta = resolveLocationMeta(parts[0]) || undefined;
  }
  if (!location && row.location_type) location = row.location_type;

  const employmentType = row.employment_type;
  const jobType =
    Array.isArray(employmentType) && employmentType.length ? employmentType[0] : employmentType || null;

  const postedAt = row.date_posted ? new Date(row.date_posted) : null;
  let timePosted = row.date_posted || null;
  if (postedAt && !Number.isNaN(postedAt.getTime())) {
    // Feeds routinely carry a date_posted a few hours ahead of us; clamp so it never reads "-1 days ago".
    const diff = Math.max(0, Math.floor((Date.now() - postedAt.getTime()) / (24 * 60 * 60 * 1000)));
    if (diff === 0) timePosted = 'Today';
    else if (diff === 1) timePosted = '1 day ago';
    else if (diff < 7) timePosted = `${diff} days ago`;
    else if (diff < 30) timePosted = `${Math.floor(diff / 7)} weeks ago`;
    else if (diff < 365) timePosted = `${Math.floor(diff / 30)} months ago`;
    else timePosted = `${Math.floor(diff / 365)} years ago`;
  }

  const remoteDerived = row.remote_derived;
  const isRemote = remoteDerived === true || remoteDerived === 'true';

  let salaryMin = null;
  let salaryMax = null;
  let salaryCurrency = null;
  const raw = row.salary_raw;
  if (raw && typeof raw === 'object') {
    if (raw.currency) salaryCurrency = raw.currency;
    // schema.org MonetaryAmount nests the range under `value` (QuantitativeValue);
    // some rows are flat instead. `value` may also be a bare number.
    const qv = raw.value && typeof raw.value === 'object' ? raw.value : {};
    const flatValue = typeof raw.value === 'number' ? raw.value : undefined;
    const min = raw.minValue ?? qv.minValue ?? qv.value ?? flatValue;
    const max = raw.maxValue ?? qv.maxValue ?? qv.value ?? flatValue;
    if (typeof min === 'number' && !Number.isNaN(min)) salaryMin = min;
    if (typeof max === 'number' && !Number.isNaN(max)) salaryMax = max;
  }
  if (row.ai_salary_minvalue != null) salaryMin = Number(row.ai_salary_minvalue);
  if (row.ai_salary_maxvalue != null) salaryMax = Number(row.ai_salary_maxvalue);
  if (row.ai_salary_currency) salaryCurrency = row.ai_salary_currency;

  return {
    externalId: jobIdUnique,
    source: sourceKey,
    title: row.title || null,
    company: row.organization || null,
    location: location || null,
    ...(locationMeta ? { locationMeta } : {}),
    // Prefer the source posting's own HTML (headings/lists/bold) over the flattened text dump.
    description: row.description_html || row.description_text || null,
    jobType,
    experienceLevel: row.seniority || null,
    isRemote,
    salaryMin,
    salaryMax,
    salaryCurrency,
    platformUrl: url || `https://www.linkedin.com/jobs/view/${jobIdUnique}`,
    postedAt,
    timePosted,
  };
}

export function buildParams(filters, source = 'active-jobs-db') {
  const { job_title: jobTitle = '', job_location: jobLocation = '', offset = 0, remote, date_posted: datePosted } = filters;
  const limit = 10;
  const off = Math.max(0, Math.floor((Number(offset) || 0) / limit) * limit);
  const timeFrame = (datePosted || '').toLowerCase().includes('7') ? '7d' : '24h';

  if (source === 'active-jobs-db') {
    const params = {
      limit: String(limit),
      offset: String(off),
      time_frame: timeFrame,
      description_format: 'text',
    };
    if (jobTitle && jobTitle.trim()) params.title = jobTitle.trim();
    if (jobLocation && jobLocation.trim()) params.location = jobLocation.trim();
    if (remote === true || remote === 'true') params.remote = 'true';
    else if (remote === false || remote === 'false') params.remote = 'false';
    return params;
  }

  const params = {
    limit: String(limit),
    offset: String(off),
    // `html` returns the posting's original markup; `text` flattens it to a wall of prose.
    description_type: 'html',
  };
  if (jobTitle && jobTitle.trim()) params.title_filter = jobTitle.trim();
  if (jobLocation && jobLocation.trim()) params.location_filter = jobLocation.trim();
  if (remote === true || remote === 'true') params.remote = 'true';
  else if (remote === false || remote === 'false') params.remote = 'false';
  return params;
}

async function searchFromAPI(filters, source, userId) {
  const apiKey = process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_API_KEY || '';
  if (!apiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'RAPIDAPI_KEY is not configured.');
  }

  const canonicalSource = normalizeSource(source);
  const config = SOURCES[canonicalSource];
  if (!config) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid source: ${source}`);
  }
  source = canonicalSource;

  checkRateLimit(userId);

  const variant = (filters.date_posted || '').toLowerCase().includes('7') ? '7d' : '24h';
  const path = config.path || config.endpoints?.[variant] || config.endpoints?.['24h'];
  const params = buildParams(filters, source);
  const query = new URLSearchParams(params).toString();
  const url = `https://${config.host}${path}?${query}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': config.host,
    },
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text();
    let msg = response.statusText;
    try {
      const data = JSON.parse(text);
      msg = data?.message || data?.error || msg;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new ApiError(response.status === 429 ? httpStatus.TOO_MANY_REQUESTS : httpStatus.BAD_GATEWAY, msg);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : (data?.jobs || data?.results || []) || [];
  return rows.map((row) => mapRowToJob(row, source));
}

async function saveJob(userId, jobData) {
  const { externalId, source, ...rest } = jobData;
  if (!externalId || !source) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'externalId and source are required.');
  }
  const canonicalSource = normalizeSource(source);
  const doc = await ExternalJob.findOneAndUpdate(
    { externalId, source: canonicalSource, savedBy: userId },
    {
      $set: {
        ...rest,
        source: canonicalSource,
        savedBy: userId,
        savedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
  await syncPublishedJobForExternal(doc);
  return doc;
}

async function getSavedJobs(userId, options = {}) {
  const filter = { savedBy: userId };
  const result = await ExternalJob.paginate(filter, {
    sortBy: 'savedAt:desc',
    limit: options.limit || 20,
    page: options.page || 1,
    ...options,
  });

  // Repair: create/update mirrored Job if missing, or publishedJobId points at a removed Job
  if (result.results?.length) {
    for (const doc of result.results) {
      let needsMirror = !doc.publishedJobId;
      if (!needsMirror && doc.publishedJobId) {
        const stillThere = await Job.exists({ _id: doc.publishedJobId });
        if (!stillThere) needsMirror = true;
      }
      if (!needsMirror) continue;
      try {
        await syncPublishedJobForExternal(doc);
      } catch (err) {
        logger.error(
          `Mirror Job sync failed for saved external ${doc.externalId} (${doc.source}): ${err?.message || err}`
        );
      }
    }
  }

  return result;
}

async function unsaveJob(userId, externalId, source) {
  const sourceFilter = source
    ? { $in: [source, normalizeSource(source)] }
    : { $in: ['active-jobs-db', 'linkedin-job-search-api', 'linkedin-jobs-api'] };
  const doc = await ExternalJob.findOne({
    externalId,
    source: sourceFilter,
    savedBy: userId,
  });
  if (!doc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Saved job not found.');
  }
  const extId = doc.externalId;
  const src = doc.source;
  await doc.deleteOne();
  await archivePublishedJobIfOrphaned(extId, src);
  return doc;
}

export default {
  searchFromAPI,
  saveJob,
  getSavedJobs,
  unsaveJob,
};
