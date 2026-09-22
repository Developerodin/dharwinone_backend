import mongoose from 'mongoose';
import Employee from '../models/employee.model.js';
import JobApplication from '../models/jobApplication.model.js';
import {
  FIT_SAMPLE_CAP_PER_JOB,
  FIT_SCORE_CAP_PER_JOB,
  LIVE_APPLICATION_STATUSES,
  STRONG_FIT_SCORE,
} from '../constants/hireForecast.js';
import { scoreSkillFit } from './hireForecast.fit.js';

const LIVE = new Set(LIVE_APPLICATION_STATUSES);

const EMPTY_STATS = Object.freeze({
  applicants: 0,
  hired: 0,
  offered: 0,
  interview: 0,
  shortlisted: 0,
  applied: 0,
  screening: 0,
  rejected: 0,
  appsLast7Days: 0,
  avgLiveFit: null,
  strongFitCount: 0,
});

/**
 * Cast mixed ids the way $match requires (find() auto-casts; aggregate does not).
 * @param {Array<string|mongoose.Types.ObjectId>} jobIds
 * @returns {mongoose.Types.ObjectId[]}
 */
export function toJobObjectIds(jobIds) {
  return (jobIds || [])
    .filter(Boolean)
    .map((value) => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value))));
}

/**
 * Prefer live-pipeline rows, then newest, capped per job.
 * @param {Array<{ candidate: *, status: string }>} rows
 * @param {number} [cap]
 * @returns {Array<{ candidate: *, status: string }>}
 */
export function pickScoreRows(rows, cap = FIT_SCORE_CAP_PER_JOB) {
  const live = [];
  const rest = [];
  for (const row of rows || []) {
    if (LIVE.has(row.status)) live.push(row);
    else rest.push(row);
  }
  return [...live, ...rest].slice(0, cap);
}

/**
 * Empty stats for a job with no applications.
 * @returns {object}
 */
export function emptyApplicationStats() {
  return { ...EMPTY_STATS };
}

/**
 * Average live-pipeline fit and strong-fit count for one job's sample.
 * @param {object} job
 * @param {Array<{ candidate: *, status: string }>} sampleRows
 * @param {Map<string, { skills?: Array }>} employeeById
 * @returns {{ avgLiveFit: number|null, strongFitCount: number }}
 */
export function scoreSampleFits(job, sampleRows, employeeById) {
  const picked = pickScoreRows(sampleRows);
  const liveFits = [];
  let strongFitCount = 0;
  for (const row of picked) {
    const emp = employeeById.get(String(row.candidate));
    const { fitScore } = scoreSkillFit(emp?.skills || [], job);
    if (!LIVE.has(row.status)) continue;
    liveFits.push(fitScore);
    if (fitScore >= STRONG_FIT_SCORE) strongFitCount += 1;
  }
  const avgLiveFit = liveFits.length
    ? Math.round(liveFits.reduce((sum, score) => sum + score, 0) / liveFits.length)
    : null;
  return { avgLiveFit, strongFitCount };
}

/**
 * Load per-job application counts plus skill-fit on a capped newest sample.
 * @param {Array<object>} jobs serialized job docs
 * @param {Date} now
 * @returns {Promise<Map<string, object>>}
 */
export async function loadSignalsForJobs(jobs, now = new Date()) {
  const byId = new Map(jobs.map((job) => [String(job.id || job._id || ''), job]));
  const ids = toJobObjectIds([...byId.keys()]);
  const out = new Map([...byId.keys()].map((id) => [id, emptyApplicationStats()]));
  if (!ids.length) return out;

  const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [countRows, sampleRows] = await Promise.all([
    JobApplication.aggregate([
      { $match: { job: { $in: ids } } },
      {
        $group: {
          _id: '$job',
          applicants: { $sum: 1 },
          hired: { $sum: { $cond: [{ $eq: ['$status', 'Hired'] }, 1, 0] } },
          offered: { $sum: { $cond: [{ $eq: ['$status', 'Offered'] }, 1, 0] } },
          interview: { $sum: { $cond: [{ $eq: ['$status', 'Interview'] }, 1, 0] } },
          shortlisted: { $sum: { $cond: [{ $eq: ['$status', 'Shortlisted'] }, 1, 0] } },
          applied: { $sum: { $cond: [{ $eq: ['$status', 'Applied'] }, 1, 0] } },
          screening: { $sum: { $cond: [{ $eq: ['$status', 'Screening'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0] } },
          appsLast7Days: { $sum: { $cond: [{ $gte: ['$createdAt', since7] }, 1, 0] } },
        },
      },
    ]),
    JobApplication.aggregate([
      { $match: { job: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$job', rows: { $push: { candidate: '$candidate', status: '$status' } } } },
      { $project: { rows: { $slice: ['$rows', FIT_SAMPLE_CAP_PER_JOB] } } },
    ]),
  ]);

  for (const row of countRows) {
    const id = String(row._id);
    out.set(id, {
      ...emptyApplicationStats(),
      applicants: row.applicants || 0,
      hired: row.hired || 0,
      offered: row.offered || 0,
      interview: row.interview || 0,
      shortlisted: row.shortlisted || 0,
      applied: row.applied || 0,
      screening: row.screening || 0,
      rejected: row.rejected || 0,
      appsLast7Days: row.appsLast7Days || 0,
    });
  }

  const candidateIds = [];
  const sampleByJob = new Map();
  for (const row of sampleRows) {
    const id = String(row._id);
    const rows = Array.isArray(row.rows) ? row.rows : [];
    sampleByJob.set(id, rows);
    for (const sample of pickScoreRows(rows)) {
      if (sample.candidate) candidateIds.push(String(sample.candidate));
    }
  }

  const uniqueCandidateIds = [...new Set(candidateIds)];
  const employees = uniqueCandidateIds.length
    ? await Employee.find({ _id: { $in: uniqueCandidateIds } })
        .select('skills')
        .lean()
    : [];
  const employeeById = new Map(employees.map((emp) => [String(emp._id), emp]));

  for (const [id, stats] of out) {
    const job = byId.get(id);
    const sample = sampleByJob.get(id) || [];
    const fits = scoreSampleFits(job || {}, sample, employeeById);
    stats.avgLiveFit = fits.avgLiveFit;
    stats.strongFitCount = fits.strongFitCount;
  }

  return out;
}
