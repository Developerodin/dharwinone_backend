import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Project from '../models/project.model.js';

/**
 * Derive a 3-5 char uppercase key base from a project name.
 * Multi-word -> initials; single-word -> first 4 chars. Never globally unique on its own.
 * @param {string} name
 * @returns {string}
 */
export function deriveProjectKeyBase(name) {
  const cleaned = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .trim();
  if (!cleaned) return 'PRJ';
  const words = cleaned.split(/\s+/).filter(Boolean);
  let base = words.length >= 2 ? words.map((w) => w[0]).join('').slice(0, 5) : words[0].slice(0, 4);
  while (base.length < 3) base += 'X';
  return base;
}

/**
 * Format a project-scoped task code, e.g. ("DBS", 7) -> "DBS-007".
 * @param {string} projectKey
 * @param {number} seq
 * @returns {string}
 */
export function formatTaskCode(projectKey, seq) {
  return `${projectKey}-${String(seq).padStart(3, '0')}`;
}

/**
 * Compute a globally-unique projectKey from a name, suffixing a number on collision.
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function assignUniqueProjectKey(name) {
  const base = deriveProjectKeyBase(name);
  const taken = new Set(
    (await Project.find({ projectKey: new RegExp(`^${base}[0-9]*$`) }).select('projectKey').lean())
      .map((p) => p.projectKey)
      .filter(Boolean)
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Could not allocate a unique project key');
}

/**
 * True when `err` is a MongoDB duplicate-key error (E11000) on the projectKey index.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isProjectKeyDuplicateError(err) {
  return Boolean(err) && err.code === 11000 && Boolean(err.keyPattern && err.keyPattern.projectKey);
}

/**
 * Atomically reserve a contiguous run of `count` task sequence numbers for a project.
 * @param {import('mongoose').Types.ObjectId|string} projectId
 * @param {number} count
 * @param {import('mongoose').ClientSession} [session]
 * @returns {Promise<number>} the first seq of the reserved range (1-based)
 */
export async function reserveTaskSeqRange(projectId, count, session) {
  if (!count || count < 1) throw new ApiError(httpStatus.BAD_REQUEST, 'count must be >= 1');
  const opts = { new: false };
  if (session) opts.session = session;
  const before = await Project.findOneAndUpdate({ _id: projectId }, { $inc: { nextTaskSeq: count } }, opts);
  if (!before) throw new ApiError(httpStatus.NOT_FOUND, 'Project not found');
  return before.nextTaskSeq || 1;
}
