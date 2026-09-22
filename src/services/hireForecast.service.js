import crypto from 'crypto';
import logger from '../config/logger.js';
import HireForecastCache from '../models/hireForecastCache.model.js';
import {
  CACHE_TTL_MS,
  LLM_BATCH_MAX,
  LLM_TIMEOUT_MS,
} from '../constants/hireForecast.js';
import { forecastFromSignals, toHireForecastDto } from './hireForecast.engine.js';
import { mergeLlmIntoHeuristic, withTimeout } from './hireForecast.parse.js';
import { generateHireForecasts } from './hireForecast.openai.js';
import { loadSignalsForJobs } from './hireForecast.signals.js';

/**
 * Stable cache key for a job's current pipeline snapshot.
 * @param {object} parts
 * @returns {string}
 */
export function forecastSignature(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Days since the job was posted.
 * @param {string|Date|null} createdAt
 * @param {number} nowMs
 * @returns {number}
 */
export function daysOpenOf(createdAt, nowMs) {
  if (!createdAt) return 0;
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / (24 * 60 * 60 * 1000)));
}

/**
 * JSON-safe job row. Mongoose toJSON keeps createdAt via the job transform.
 * @param {object} job
 * @returns {object}
 */
export function serializeJob(job) {
  if (!job) return job;
  if (typeof job.toJSON === 'function') return job.toJSON();
  if (typeof job.toObject === 'function') return job.toObject();
  return { ...job };
}

/**
 * @param {object} job
 * @param {object} stats
 * @param {Date} now
 * @returns {{ job: object, jobId: string, signals: object, forecast: object, signature: string }}
 */
export function prepareJobForecast(job, stats, now) {
  const jobId = String(job?.id || job?._id || '');
  const signals = {
    ...(stats || {}),
    status: job?.status,
    vacancies: job?.vacancies,
    experienceLevel: job?.experienceLevel,
    daysOpen: daysOpenOf(job?.createdAt, now.getTime()),
  };
  const forecast = forecastFromSignals(signals);
  const avgFitBucket = Math.floor((Number(signals.avgLiveFit) || 0) / 10);
  const signature = forecastSignature({
    jobId,
    vacancies: signals.vacancies ?? 1,
    remaining: forecast.remainingVacancies,
    applicants: signals.applicants || 0,
    hired: signals.hired || 0,
    avgFitBucket,
    funnel: `${signals.applied || 0}:${signals.screening || 0}:${signals.interview || 0}:${signals.shortlisted || 0}:${signals.offered || 0}`,
    status: job?.status || '',
  });
  return { job, jobId, signals, forecast, signature };
}

/**
 * Prompt row: numeric signals only, no candidate PII.
 * @param {{ jobId: string, signals: object, forecast: object }} prepared
 * @returns {object}
 */
export function toLlmItem(prepared) {
  const { jobId, signals, forecast } = prepared;
  return {
    id: jobId,
    experienceLevel: signals.experienceLevel || null,
    remainingVacancies: forecast.remainingVacancies,
    applicants: signals.applicants || 0,
    hired: signals.hired || 0,
    offered: signals.offered || 0,
    interview: signals.interview || 0,
    shortlisted: signals.shortlisted || 0,
    applied: signals.applied || 0,
    screening: signals.screening || 0,
    avgLiveFit: signals.avgLiveFit,
    strongFitCount: signals.strongFitCount || 0,
    appsLast7Days: signals.appsLast7Days || 0,
    daysOpen: signals.daysOpen || 0,
    heuristicDaysLow: forecast.daysLow,
    heuristicDaysHigh: forecast.daysHigh,
    confidence: forecast.confidence,
  };
}

/**
 * @param {string[]} signatures
 * @param {Date} now
 * @returns {Promise<Array<{ signature: string, payload: object }>>}
 */
async function defaultCacheFind(signatures, now) {
  if (!signatures.length) return [];
  return HireForecastCache.find({ signature: { $in: signatures }, expiresAt: { $gt: now } })
    .select('signature payload')
    .lean();
}

/**
 * @param {{ signature: string, payload: object }} row
 * @param {Date} now
 */
async function defaultCacheWrite(row, now) {
  await HireForecastCache.updateOne(
    { signature: row.signature },
    {
      $set: {
        payload: row.payload,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      },
    },
    { upsert: true }
  );
}

/**
 * Build the list payload from heuristic ± optional LLM overlay.
 * @param {object} prepared
 * @param {{ id: string, daysLow: number, daysHigh: number, rationale: string }|null} llmRow
 * @returns {object}
 */
function dtoFromPrepared(prepared, llmRow) {
  const merged = mergeLlmIntoHeuristic(prepared.forecast, llmRow || null);
  return toHireForecastDto(merged, {
    applicants: prepared.signals.applicants || 0,
    strongFitCount: prepared.signals.strongFitCount || 0,
    source: merged.llmMerged ? 'llm' : 'heuristic',
    rationale: merged.heuristicRationale,
  });
}

/**
 * Persist LLM overlays only. Heuristic misses must not occupy the 12h cache.
 * @param {object[]} prepared
 * @param {Array<{ id: string, daysLow: number, daysHigh: number, rationale: string }>} llmRows
 * @param {Function} cacheWrite
 * @param {Date} now
 * @returns {Promise<Map<string, object>>} llm rows keyed by job id
 */
export async function persistLlmForecasts(prepared, llmRows, cacheWrite, now) {
  const llmById = new Map();
  for (const row of llmRows || []) {
    if (row?.id) llmById.set(String(row.id), row);
  }
  const writes = [];
  for (const row of prepared) {
    if (row.forecast.filled) continue;
    const llm = llmById.get(row.jobId);
    if (!llm) continue;
    const dto = dtoFromPrepared(row, llm);
    if (dto.source !== 'llm') continue;
    writes.push({ signature: row.signature, payload: dto });
  }
  await Promise.all(
    writes.map(async (row) => {
      try {
        await cacheWrite(row, now);
      } catch (err) {
        logger.warn(`hireForecast cache write failed: ${err?.message || err}`);
      }
    })
  );
  return llmById;
}

/**
 * Run the page-level LLM batch and cache successful overlays.
 * @param {object[]} misses
 * @param {Function} generateBatch
 * @param {Function} cacheWrite
 * @param {Date} now
 * @param {number} timeoutMs
 * @returns {Promise<Map<string, object>>}
 */
async function runLlmBatch(misses, generateBatch, cacheWrite, now, timeoutMs) {
  const batch = misses.slice(0, LLM_BATCH_MAX).map(toLlmItem);
  const rows = await withTimeout(generateBatch(batch), timeoutMs, 'hire-forecast');
  return persistLlmForecasts(misses, rows, cacheWrite, now);
}

/**
 * Attach hireForecast onto each staff-list job. Failures fall back to heuristic.
 * The list does not wait on OpenAI unless `awaitLlm` is set (tests).
 * @param {object[]} jobs
 * @param {{ loadSignals?: Function, cacheFind?: Function, cacheWrite?: Function, generateBatch?: Function, now?: Date, timeoutMs?: number, awaitLlm?: boolean }} [deps]
 * @returns {Promise<object[]>}
 */
export async function attachHireForecasts(jobs, deps = {}) {
  if (!Array.isArray(jobs) || jobs.length === 0) return jobs;
  const now = deps.now || new Date();
  const timeoutMs = deps.timeoutMs ?? LLM_TIMEOUT_MS;
  const serialized = jobs.map(serializeJob);
  const loadSignals = deps.loadSignals || loadSignalsForJobs;
  const cacheFind = deps.cacheFind || defaultCacheFind;
  const cacheWrite = deps.cacheWrite || defaultCacheWrite;
  const generateBatch = deps.generateBatch || generateHireForecasts;

  let signalsByJob = new Map();
  try {
    signalsByJob = await loadSignals(serialized, now);
  } catch (err) {
    logger.warn(`hireForecast signal load failed: ${err?.message || err}`);
  }

  const prepared = serialized.map((job) =>
    prepareJobForecast(job, signalsByJob.get(String(job.id || job._id || '')), now)
  );

  let cached = [];
  try {
    cached = await cacheFind(
      prepared.map((row) => row.signature),
      now
    );
  } catch (err) {
    logger.warn(`hireForecast cache read failed: ${err?.message || err}`);
  }
  const cachedBySig = new Map((cached || []).map((row) => [row.signature, row.payload]));

  const misses = prepared.filter((row) => !row.forecast.filled && !cachedBySig.has(row.signature));
  let llmById = new Map();
  if (misses.length && deps.awaitLlm) {
    try {
      llmById = await runLlmBatch(misses, generateBatch, cacheWrite, now, timeoutMs);
    } catch (err) {
      logger.warn(`hireForecast llm failed: ${err?.message || err}`);
    }
  } else if (misses.length) {
    runLlmBatch(misses, generateBatch, cacheWrite, now, timeoutMs).catch((err) => {
      logger.warn(`hireForecast llm failed: ${err?.message || err}`);
    });
  }

  return prepared.map((row) => {
    const cachedPayload = cachedBySig.get(row.signature);
    if (cachedPayload && typeof cachedPayload === 'object') {
      return { ...row.job, hireForecast: cachedPayload };
    }
    return { ...row.job, hireForecast: dtoFromPrepared(row, llmById.get(row.jobId) || null) };
  });
}
