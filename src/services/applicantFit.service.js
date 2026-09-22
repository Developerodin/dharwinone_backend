import logger from '../config/logger.js';
import ApplicantFitCache from '../models/applicantFitCache.model.js';
import Job from '../models/job.model.js';
import Employee from '../models/employee.model.js';
import {
  CACHE_TTL_MS,
  LLM_BACKGROUND_TIMEOUT_MS,
  LLM_BATCH_MAX,
  LLM_TIMEOUT_MS,
} from '../constants/applicantFit.js';
import {
  extractRefId,
  prepareApplicantFit,
  toApplicantFitDto,
} from './applicantFit.engine.js';
import { mergeLlmIntoHeuristic } from './applicantFit.parse.js';
import { withTimeout } from './hireForecast.parse.js';
import { generateApplicantFits } from './applicantFit.openai.js';

export { fitSignature, prepareApplicantFit } from './applicantFit.engine.js';

/**
 * JSON-safe application row.
 * @param {object} app
 * @returns {object}
 */
export function serializeApp(app) {
  if (!app) return app;
  if (typeof app.toJSON === 'function') return app.toJSON();
  if (typeof app.toObject === 'function') return app.toObject();
  return { ...app };
}

/**
 * Prompt row: JD + skills + profile, no candidate PII.
 * @param {{ applicationId: string, prompt: object, heuristic: object }} prepared
 * @returns {object}
 */
export function toLlmItem(prepared) {
  const { applicationId, prompt, heuristic } = prepared;
  return {
    id: applicationId,
    heuristicSuccess: heuristic.successProbability,
    matchedSkills: prompt.matchedSkills,
    missingSkills: prompt.missingSkills,
    job: {
      title: prompt.title,
      jd: prompt.jd,
      skillTags: prompt.skillTags,
      skillRequirements: prompt.skillRequirements,
      experienceLevel: prompt.experienceLevel,
      jobType: prompt.jobType,
      location: prompt.location,
    },
    applicant: {
      skills: prompt.skills,
      department: prompt.department,
      designation: prompt.designation,
      shortBio: prompt.shortBio,
      experiences: prompt.experiences,
      qualifications: prompt.qualifications,
      coverLetter: prompt.coverLetter,
    },
  };
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>}
 */
async function defaultLoadJobs(ids) {
  if (!ids.length) return new Map();
  const rows = await Job.find({ _id: { $in: ids } })
    .select('title jobDescription skillTags skillRequirements experienceLevel jobType location')
    .lean();
  return new Map((rows || []).map((row) => [String(row._id), row]));
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>}
 */
async function defaultLoadEmployees(ids) {
  if (!ids.length) return new Map();
  const rows = await Employee.find({ _id: { $in: ids } })
    .select('skills department designation shortBio experiences qualifications')
    .lean();
  return new Map((rows || []).map((row) => [String(row._id), row]));
}

/**
 * @param {string[]} signatures
 * @param {Date} now
 * @returns {Promise<Array<{ signature: string, payload: object }>>}
 */
async function defaultCacheFind(signatures, now) {
  if (!signatures.length) return [];
  return ApplicantFitCache.find({ signature: { $in: signatures }, expiresAt: { $gt: now } })
    .select('signature payload')
    .lean();
}

/**
 * @param {{ signature: string, payload: object }} row
 * @param {Date} now
 */
async function defaultCacheWrite(row, now) {
  await ApplicantFitCache.updateOne(
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
 * @param {{ id: string, successProbability: number, culturalFit: string, rationale: string }|null} llmRow
 * @returns {object}
 */
function dtoFromPrepared(prepared, llmRow) {
  return toApplicantFitDto(mergeLlmIntoHeuristic(prepared.heuristic, llmRow || null));
}

/**
 * Persist LLM overlays only. Heuristic misses must not occupy the 12h cache.
 * @param {object[]} prepared
 * @param {Array<{ id: string, successProbability: number, culturalFit: string, rationale: string }>} llmRows
 * @param {Function} cacheWrite
 * @param {Date} now
 * @returns {Promise<Map<string, object>>}
 */
export async function persistLlmFits(prepared, llmRows, cacheWrite, now) {
  const llmById = new Map();
  for (const row of llmRows || []) {
    if (row?.id) llmById.set(String(row.id), row);
  }
  const writes = [];
  for (const row of prepared) {
    const llm = llmById.get(row.applicationId);
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
        logger.warn(`applicantFit cache write failed: ${err?.message || err}`);
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
  const rows = await withTimeout(generateBatch(batch), timeoutMs, 'applicant-fit');
  return persistLlmFits(misses, rows, cacheWrite, now);
}

/**
 * Unique populated-ref ids from a page of applications.
 * @param {object[]} apps
 * @returns {{ jobIds: string[], candidateIds: string[] }}
 */
export function collectFitIds(apps) {
  const jobIds = [];
  const candidateIds = [];
  const seenJobs = new Set();
  const seenCands = new Set();
  for (const app of apps) {
    const jobId = extractRefId(app?.job);
    const candidateId = extractRefId(app?.candidate);
    if (jobId && !seenJobs.has(jobId)) {
      seenJobs.add(jobId);
      jobIds.push(jobId);
    }
    if (candidateId && !seenCands.has(candidateId)) {
      seenCands.add(candidateId);
      candidateIds.push(candidateId);
    }
  }
  return { jobIds, candidateIds };
}

/**
 * Attach applicantFit onto each staff-list application. Failures fall back to heuristic.
 * The list does not wait on OpenAI unless `awaitLlm` is set (tests).
 * @param {object[]} apps
 * @param {{ loadJobs?: Function, loadEmployees?: Function, cacheFind?: Function, cacheWrite?: Function, generateBatch?: Function, now?: Date, timeoutMs?: number, awaitLlm?: boolean }} [deps]
 * @returns {Promise<object[]>}
 */
export async function attachApplicantFit(apps, deps = {}) {
  if (!Array.isArray(apps) || apps.length === 0) return apps;
  const now = deps.now || new Date();
  const timeoutMs =
    deps.timeoutMs ?? (deps.awaitLlm ? LLM_TIMEOUT_MS : LLM_BACKGROUND_TIMEOUT_MS);
  const serialized = apps.map(serializeApp);
  const loadJobs = deps.loadJobs || defaultLoadJobs;
  const loadEmployees = deps.loadEmployees || defaultLoadEmployees;
  const cacheFind = deps.cacheFind || defaultCacheFind;
  const cacheWrite = deps.cacheWrite || defaultCacheWrite;
  const generateBatch = deps.generateBatch || generateApplicantFits;

  const { jobIds, candidateIds } = collectFitIds(serialized);
  let jobsById = new Map();
  let employeesById = new Map();
  try {
    jobsById = await loadJobs(jobIds);
  } catch (err) {
    logger.warn(`applicantFit job load failed: ${err?.message || err}`);
  }
  try {
    employeesById = await loadEmployees(candidateIds);
  } catch (err) {
    logger.warn(`applicantFit employee load failed: ${err?.message || err}`);
  }

  const prepared = serialized.map((app) =>
    prepareApplicantFit(
      app,
      jobsById.get(extractRefId(app?.job)) || null,
      employeesById.get(extractRefId(app?.candidate)) || null
    )
  );

  let cached = [];
  try {
    cached = await cacheFind(
      prepared.map((row) => row.signature),
      now
    );
  } catch (err) {
    logger.warn(`applicantFit cache read failed: ${err?.message || err}`);
  }
  const cachedBySig = new Map((cached || []).map((row) => [row.signature, row.payload]));

  const misses = prepared.filter((row) => !cachedBySig.has(row.signature));
  let llmById = new Map();
  if (misses.length && deps.awaitLlm) {
    try {
      llmById = await runLlmBatch(misses, generateBatch, cacheWrite, now, timeoutMs);
    } catch (err) {
      logger.warn(`applicantFit llm failed: ${err?.message || err}`);
    }
  } else if (misses.length) {
    runLlmBatch(misses, generateBatch, cacheWrite, now, timeoutMs).catch((err) => {
      logger.warn(`applicantFit llm failed: ${err?.message || err}`);
    });
  }

  return prepared.map((row) => {
    const cachedPayload = cachedBySig.get(row.signature);
    if (cachedPayload && typeof cachedPayload === 'object') {
      return { ...row.app, applicantFit: cachedPayload };
    }
    return { ...row.app, applicantFit: dtoFromPrepared(row, llmById.get(row.applicationId) || null) };
  });
}
