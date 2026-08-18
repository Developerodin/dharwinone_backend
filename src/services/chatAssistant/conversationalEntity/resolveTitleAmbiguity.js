// Job posting title vs employee designation/position — parallel resolver.

import Job from '../../../models/job.model.js';
import Employee from '../../../models/employee.model.js';
import Position from '../../../models/position.model.js';
import { designationRegexForPhrase } from '../managerCounts.js';
import { cleanSubject } from './queryPatterns.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const JOB_ONLY_RE =
  /\b(openings?|job postings?|vacanc(?:y|ies)|postings?|salary for the .+ job|requirements for the .+ job)\b/i;
const EMPLOYEE_ONLY_RE =
  /\b(who works as|how many .+ do we have|employees with (?:position|designation|title)|people with (?:position|designation|title))\b/i;

const POSITION_COUNT_RE =
  /\bhow many\s+(.+?)(?:\s+(?:employees?|staff|people))?(?:\s+do we have|\?|$)/i;
const WHO_WORKS_AS_RE = /\bwho works as\s+(.+)/i;
const EMPLOYEES_WITH_POSITION_RE =
  /\bemployees?\s+with\s+(?:position|designation|title)\s+(.+)/i;
const WHICH_EMPLOYEE_HAS_RE =
  /\bwhich employees? (?:has|have|with)\s+(.+)/i;

/**
 * Linguistic routing — skip ambiguity when the user names one side.
 * @param {string} message
 * @returns {'job'|'employee'|'neutral'}
 */
export function detectTitleIntent(message) {
  const text = String(message || '');
  if (JOB_ONLY_RE.test(text)) return 'job';
  if (EMPLOYEE_ONLY_RE.test(text)) return 'employee';
  return 'neutral';
}

/**
 * Extract a job-title / designation phrase from count/list phrasing.
 * @param {string} message
 * @returns {string|null}
 */
export function parseDesignationFromMessage(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  let   hit = text.match(WHO_WORKS_AS_RE);
  if (hit) return cleanSubject(hit[1]);

  hit = text.match(WHICH_EMPLOYEE_HAS_RE);
  if (hit) return cleanSubject(hit[1]);

  hit = text.match(EMPLOYEES_WITH_POSITION_RE);
  if (hit) return cleanSubject(hit[1]);

  hit = text.match(POSITION_COUNT_RE);
  if (hit) {
    const phrase = cleanSubject(hit[1]);
    if (phrase && !/^(active|resigned|paid|unpaid|current|former|working|all)$/i.test(phrase)) {
      return phrase;
    }
  }

  return null;
}

function slimJob(row) {
  return {
    kind: 'job',
    jobId: row._id,
    title: row.title,
    status: row.status || null,
    jobType: row.jobType || null,
    location: row.location || null,
    organisation: row.organisation?.name || null,
  };
}

function slimEmployee(row) {
  return {
    kind: 'employee',
    empDocId: row._id,
    owner: row.owner,
    name: row.fullName,
    designation: row.designation || null,
    department: row.department || null,
    employeeId: row.employeeId || null,
  };
}

/**
 * @param {string} title
 * @param {object} [opts]
 * @param {'job'|'employee'|'neutral'} [opts.intent]
 * @param {object} [opts.Job]
 * @param {object} [opts.Employee]
 * @param {object} [opts.Position]
 */
export async function resolveTitleAmbiguity(title, opts = {}) {
  const trimmed = String(title || '').trim();
  if (!trimmed) {
    return { kind: 'notFound', jobMatches: [], employeeMatches: [] };
  }

  const JobModel = opts.Job ?? Job;
  const EmployeeModel = opts.Employee ?? Employee;
  const PositionModel = opts.Position ?? Position;
  const intent = opts.intent ?? 'neutral';
  const safe = escapeRegex(trimmed);
  const desigFilter = designationRegexForPhrase(trimmed);

  const [jobs, byDesignation, positions] = await Promise.all([
    JobModel.find({
      title: { $regex: safe, $options: 'i' },
      status: { $ne: 'Archived' },
    })
      .select('_id title status jobType location organisation.name salaryRange')
      .limit(10)
      .lean(),
    EmployeeModel.find({ designation: desigFilter })
      .select('_id fullName designation department owner employeeId')
      .limit(10)
      .lean(),
    PositionModel.find({ name: desigFilter })
      .select('_id name')
      .limit(5)
      .lean(),
  ]);

  let byPosition = [];
  if (positions.length) {
    byPosition = await EmployeeModel.find({ position: { $in: positions.map((p) => p._id) } })
      .select('_id fullName designation department owner employeeId')
      .limit(10)
      .lean();
  }

  const employeeMap = new Map();
  for (const row of [...byDesignation, ...byPosition]) {
    employeeMap.set(String(row._id), row);
  }
  const employeeMatches = [...employeeMap.values()].map(slimEmployee);
  const jobMatches = jobs.map(slimJob);

  if (intent === 'job') {
    if (!jobMatches.length) return { kind: 'notFound', jobMatches: [], employeeMatches: [] };
    return { kind: 'unique', target: 'job', jobMatches, employeeMatches: [] };
  }
  if (intent === 'employee') {
    if (!employeeMatches.length) return { kind: 'notFound', jobMatches: [], employeeMatches: [] };
    return { kind: 'unique', target: 'employee', jobMatches: [], employeeMatches };
  }

  const hasJobs = jobMatches.length > 0;
  const hasEmployees = employeeMatches.length > 0;
  if (hasJobs && hasEmployees) {
    return { kind: 'ambiguous', jobMatches, employeeMatches };
  }
  if (hasJobs) return { kind: 'unique', target: 'job', jobMatches, employeeMatches: [] };
  if (hasEmployees) return { kind: 'unique', target: 'employee', jobMatches: [], employeeMatches };
  return { kind: 'notFound', jobMatches: [], employeeMatches: [] };
}
