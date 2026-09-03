import httpStatus from 'http-status';
import ExternalJob from '../models/externalJob.model.js';
import Job from '../models/job.model.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { syncPublishedJobForExternal, archivePublishedJobIfOrphaned } from './externalJobPublishedJob.service.js';
import { resolveLocationMeta, resolveCountry } from '../utils/jobLocation.util.js';

const SOURCES = {
  'active-jobs-db': {
    host: 'active-jobs-db.p.rapidapi.com',
    path: '/active-ats',
    timeFrames: ['24h', '7d', '6m'],
  },
  'linkedin-job-search-api': {
    host: 'linkedin-job-search-api.p.rapidapi.com',
    endpoints: { '24h': '/active-jb-24h', '7d': '/active-jb-7d' },
    timeFrames: ['24h', '7d'],
  },
};

/**
 * Posted-window options the UI offers, mapped to the `time_frame` RapidAPI accepts.
 *
 * `all` is an application-only value and is never sent: Active Jobs DB's windows
 * nest (24h is inside 7d is inside 6m), so "All Time" IS the 6m window. Requesting
 * all three would return the 6m set plus two subsets of itself, spend three of the
 * five requests a user gets per minute, and leave three independently-ordered
 * offset streams that cannot share one `offset` without repeating or skipping rows.
 */
const POSTED_TIME_FRAMES = { '24h': '24h', '7d': '7d', '6m': '6m', all: '6m' };
const DEFAULT_TIME_FRAME = '24h';

const LEGACY_SOURCE_ALIASES = {
  'linkedin-jobs-api': 'linkedin-job-search-api',
};

function normalizeSource(source) {
  return LEGACY_SOURCE_ALIASES[source] || source;
}

/**
 * date_posted (UI value) -> time_frame (RapidAPI value), rejected when the source
 * has no endpoint for that window. LinkedIn only publishes 24h and 7d feeds, so
 * `6m`/`all` are refused rather than quietly served as 7 days.
 */
export function resolveTimeFrame(datePosted, source) {
  const timeFrame = POSTED_TIME_FRAMES[String(datePosted || '').trim().toLowerCase()] || DEFAULT_TIME_FRAME;
  const supported = SOURCES[normalizeSource(source)]?.timeFrames;
  if (supported && !supported.includes(timeFrame)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `This source only covers jobs posted in the last ${supported.join(' or ')}.`
    );
  }
  return timeFrame;
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

    const first = loc[0];
    if (first && typeof first === 'object' && (first.city || first.admin || first.country)) {
      // API already gives structured city/admin/country -- use it directly instead
      // of re-parsing the joined display string. country-state-city is only needed
      // for the one thing the API doesn't give us: the ISO country code.
      const countryRes = first.country ? resolveCountry(first.country) : null;
      const meta = {};
      if (first.city) meta.city = first.city;
      if (first.admin) meta.state = first.admin;
      if (countryRes) {
        meta.country = countryRes.countryName;
        meta.countryCode = countryRes.countryCode;
      } else if (first.country) {
        meta.country = first.country;
      }
      if (Object.keys(meta).length) locationMeta = meta;
    } else if (parts[0]) {
      // Fallback for rows where locations_derived holds plain strings, not objects.
      locationMeta = resolveLocationMeta(parts[0]) || undefined;
    }
  }
  if (!location && row.location_type) location = row.location_type;

  const employmentType = row.ai_employment_type ?? row.employment_type;
  let jobType =
    Array.isArray(employmentType) && employmentType.length ? employmentType[0] : employmentType || null;
  if (typeof jobType === 'string' && jobType.includes('_')) {
    jobType = jobType
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

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
  // RapidAPI renamed salary_raw -> salary (2025); keep both for compatibility.
  const raw = row.salary ?? row.salary_raw;
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
  const aiMin = row.ai_salary_min_value ?? row.ai_salary_minvalue;
  const aiMax = row.ai_salary_max_value ?? row.ai_salary_maxvalue;
  const aiValue = row.ai_salary_value;
  if (aiMin != null) salaryMin = Number(aiMin);
  if (aiMax != null) salaryMax = Number(aiMax);
  if (salaryMin == null && salaryMax == null && aiValue != null) {
    const single = Number(aiValue);
    if (!Number.isNaN(single)) {
      salaryMin = single;
      salaryMax = single;
    }
  }
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

const WORK_ARRANGEMENT_MAP = {
  remote_ok: 'Remote OK',
  remote_solely: 'Remote Solely',
  remote_both: 'Remote OK,Remote Solely',
};

export function resolveWorkArrangement(filters = {}) {
  const { work_arrangement: workArrangement, remote } = filters;
  if (workArrangement && WORK_ARRANGEMENT_MAP[workArrangement]) {
    return WORK_ARRANGEMENT_MAP[workArrangement];
  }
  // Legacy: remote=true without work_arrangement → both remote types.
  if (remote === true || remote === 'true') {
    return WORK_ARRANGEMENT_MAP.remote_both;
  }
  return null;
}

export function buildParams(filters, source = 'active-jobs-db') {
  const { job_title: jobTitle = '', job_location: jobLocation = '', offset = 0, date_posted: datePosted } = filters;
  const limit = 10;
  const off = Math.max(0, Math.floor((Number(offset) || 0) / limit) * limit);
  const timeFrame = resolveTimeFrame(datePosted, source);
  const aiWorkArrangement = resolveWorkArrangement(filters);

  if (source === 'active-jobs-db') {
    const params = {
      limit: String(limit),
      offset: String(off),
      time_frame: timeFrame,
      description_format: 'text',
    };
    if (jobTitle && jobTitle.trim()) params.title = jobTitle.trim();
    if (jobLocation && jobLocation.trim()) params.location = jobLocation.trim();
    if (aiWorkArrangement) params.ai_work_arrangement = aiWorkArrangement;
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
  if (aiWorkArrangement) params.ai_work_arrangement = aiWorkArrangement;
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

  const variant = resolveTimeFrame(filters.date_posted, source);
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

/** Active Jobs DB only -- returns externalId-formatted ids (`ext_<id>`) that expired within timeFrame. */
async function fetchExpiredIds(timeFrame, userId) {
  const apiKey = process.env.RAPIDAPI_KEY || process.env.RAPIDAPI_API_KEY || '';
  if (!apiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'RAPIDAPI_KEY is not configured.');
  }
  checkRateLimit(userId);

  const host = SOURCES['active-jobs-db'].host;
  const query = new URLSearchParams({ time_frame: timeFrame }).toString();
  const response = await fetch(`https://${host}/expired-ats?${query}`, {
    method: 'GET',
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host },
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const text = await response.text();
    let msg = response.statusText;
    try {
      const data = JSON.parse(text);
      msg = data?.detail || data?.message || data?.error || msg;
    } catch {
      if (text) msg = text.slice(0, 200);
    }
    throw new ApiError(response.status === 429 ? httpStatus.TOO_MANY_REQUESTS : httpStatus.BAD_GATEWAY, msg);
  }

  const ids = await response.json();
  return (Array.isArray(ids) ? ids : []).map((id) => `ext_${id}`);
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
  fetchExpiredIds,
  saveJob,
  getSavedJobs,
  unsaveJob,
};
