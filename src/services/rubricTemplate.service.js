import httpStatus from 'http-status';
import mongoose from 'mongoose';
import RubricTemplate from '../models/rubricTemplate.model.js';
import Job from '../models/job.model.js';
import ApiError from '../utils/ApiError.js';
import { DEFAULT_RUBRIC_CRITERIA, criteriaWeightError } from '../constants/interviewRubric.js';

/** Copy a criteria list into plain objects, dropping anything mongoose adds. */
const plainCriteria = (criteria) =>
  (criteria || []).map((c) => ({
    key: String(c.key).trim(),
    label: String(c.label).trim(),
    weight: Number(c.weight),
    scaleMin: Number(c.scaleMin ?? 1),
    scaleMax: Number(c.scaleMax ?? 5),
  }));

/**
 * Pick the most specific template for a round. PURE — no database, so the precedence
 * rule is testable on its own and the DB query stays a plain "every live template that
 * could apply" fetch.
 *
 * Job targeting moved to Job.rubricAssignments (audit J1). Only round-type targeting and
 * the house default remain here: type 1, default 0. A template targeting a DIFFERENT
 * round type is not a candidate at all.
 *
 * @param {Array<object>} templates
 * @param {{roundType?: string|null}} target
 * @returns {object|null}
 */
export const pickMostSpecificTemplate = (templates, { roundType } = {}) => {
  const list = Array.isArray(templates) ? templates : [];
  let best = null;
  let bestScore = -1;

  for (const template of list) {
    const tType = template?.appliesTo?.roundType ?? null;

    if (tType && tType !== roundType) continue;

    let score;
    if (tType) score = 1;
    else if (template?.isDefault) score = 0;
    else continue; // untargeted and not the default — never auto-applies

    if (score > bestScore) {
      best = template;
      bestScore = score;
    }
  }

  return best;
};

/**
 * Pick a job's assignment for a round. PURE — no database, so the precedence rule is
 * testable on its own.
 *
 * A row naming this round type wins; otherwise the job's `roundType: null` default applies.
 * If the job has neither, this returns null and resolution falls through to the template
 * rungs — including for a round with no type at all, which only the default row can
 * cover (audit J7).
 *
 * @param {Array<object>} assignments - Job.rubricAssignments
 * @param {string|null} roundType
 * @returns {object|null}
 */
export const pickJobAssignment = (assignments, roundType) => {
  const rows = Array.isArray(assignments) ? assignments : [];
  if (!rows.length) return null;
  if (roundType) {
    const exact = rows.find((r) => r?.roundType === roundType);
    if (exact) return exact;
  }
  return rows.find((r) => (r?.roundType ?? null) === null) || null;
};

/**
 * Resolve the rubric a round should be scored against, most specific first:
 *
 *   1. the job's assignment for this round type
 *   2. the job's default assignment
 *   3. a template targeting this round type
 *   4. the template flagged isDefault
 *   5. DEFAULT_RUBRIC_CRITERIA in code
 *
 * The first rung that matches wins and nothing below it is consulted. Rungs 1–2 come from
 * the job; `appliesTo.jobId` is deliberately NOT consulted any more, so a job's rubric has
 * exactly one place to be set (audit J1).
 *
 * A row pointing at a template resolves that template even when it is archived: a job
 * deliberately assigned a rubric must not silently fall back to the house default because
 * someone tidied up. Archiving a referenced template is refused separately (audit J3).
 *
 * @param {{jobId?: string|null, roundType?: string|null}} target
 * @returns {Promise<{templateId: mongoose.Types.ObjectId|null, templateName: string, criteria: Array<object>}>}
 */
export const resolveRubricForRound = async ({ jobId = null, roundType = null } = {}) => {
  if (jobId && mongoose.Types.ObjectId.isValid(jobId)) {
    const job = await Job.findById(jobId).select('rubricAssignments').lean();
    const assignment = pickJobAssignment(job?.rubricAssignments, roundType);

    if (assignment?.criteria?.length) {
      return {
        templateId: null,
        templateName: 'Custom for this job',
        criteria: plainCriteria(assignment.criteria),
      };
    }

    if (assignment?.templateId) {
      const template = await RubricTemplate.findById(assignment.templateId).lean();
      if (template) {
        return {
          templateId: template._id,
          templateName: template.name,
          criteria: plainCriteria(template.criteria),
        };
      }
      // The template is gone entirely. Fall through rather than throw — a dangling
      // reference must not stop an interview being scheduled.
    }
  }

  const or = [{ isDefault: true }];
  if (roundType) or.push({ 'appliesTo.roundType': roundType });

  const candidates = await RubricTemplate.find({ archivedAt: null, $or: or }).lean();
  const picked = pickMostSpecificTemplate(candidates, { roundType });

  if (!picked) {
    return {
      templateId: null,
      templateName: 'Default rubric',
      criteria: plainCriteria(DEFAULT_RUBRIC_CRITERIA),
    };
  }
  return {
    templateId: picked._id,
    templateName: picked.name,
    criteria: plainCriteria(picked.criteria),
  };
};

const assertValidCriteria = (criteria) => {
  const reason = criteriaWeightError(criteria);
  if (reason) throw new ApiError(httpStatus.BAD_REQUEST, reason);
};

/**
 * At most one live default. Demoting the previous one rather than refusing the write
 * means "make this the default" always succeeds, which is what the admin screen needs;
 * the alternative is an error the user can only clear by editing another record.
 */
const demoteOtherDefaults = async (keepId) => {
  const filter = { isDefault: true, archivedAt: null };
  if (keepId) filter._id = { $ne: keepId };
  await RubricTemplate.updateMany(filter, { $set: { isDefault: false } });
};

export const createRubricTemplate = async (body, userId, tenantId = null) => {
  assertValidCriteria(body.criteria);
  const doc = await RubricTemplate.create({
    name: body.name,
    description: body.description || '',
    criteria: plainCriteria(body.criteria),
    appliesTo: {
      jobId: body.appliesTo?.jobId || null,
      roundType: body.appliesTo?.roundType || null,
    },
    isDefault: Boolean(body.isDefault),
    createdBy: userId,
    tenantId: tenantId || null,
  });
  if (doc.isDefault) await demoteOtherDefaults(doc._id);
  return doc;
};

export const getRubricTemplateById = async (id) => {
  const doc = await RubricTemplate.findById(id);
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Rubric template not found');
  return doc;
};

export const queryRubricTemplates = async (filter, options) => RubricTemplate.paginate(filter, options);

export const updateRubricTemplate = async (id, body, userId) => {
  const doc = await getRubricTemplateById(id);
  if (doc.archivedAt) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This rubric is archived. Restore it before editing.');
  }
  if (body.criteria !== undefined) {
    assertValidCriteria(body.criteria);
    doc.criteria = plainCriteria(body.criteria);
  }
  if (body.name !== undefined) doc.name = body.name;
  if (body.description !== undefined) doc.description = body.description;
  if (body.appliesTo !== undefined) {
    doc.appliesTo = {
      jobId: body.appliesTo?.jobId || null,
      roundType: body.appliesTo?.roundType || null,
    };
  }
  if (body.isDefault !== undefined) doc.isDefault = Boolean(body.isDefault);
  doc.updatedBy = userId;
  await doc.save();
  if (doc.isDefault) await demoteOtherDefaults(doc._id);
  return doc;
};

/**
 * Jobs whose assignments reference this template. Capped — the caller only needs enough
 * names to make an error message actionable.
 *
 * @param {string} templateId
 * @param {number} [limit]
 * @returns {Promise<Array<{id: string, title: string}>>}
 */
export const jobsUsingTemplate = async (templateId, limit = 25) => {
  if (!templateId || !mongoose.Types.ObjectId.isValid(templateId)) return [];
  const rows = await Job.find({ 'rubricAssignments.templateId': templateId })
    .select('title')
    .limit(limit)
    .lean();
  return rows.map((j) => ({ id: String(j._id), title: j.title || 'Untitled job' }));
};

/**
 * Job counts for many templates at once.
 *
 * One aggregation rather than a countDocuments per row: the template list renders up to a
 * hundred templates, and an N+1 there is a page-load cliff (audit J15).
 *
 * $addToSet on the job id matters — a job with both a default row and a round row pointing
 * at the same template is ONE job using it, not two.
 *
 * @param {Array<string>} templateIds
 * @returns {Promise<Map<string, number>>} templateId → job count
 */
export const countJobsByTemplate = async (templateIds) => {
  const ids = (templateIds || [])
    .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  const counts = new Map(ids.map((id) => [String(id), 0]));
  if (!ids.length) return counts;

  const rows = await Job.aggregate([
    { $match: { 'rubricAssignments.templateId': { $in: ids } } },
    { $unwind: '$rubricAssignments' },
    { $match: { 'rubricAssignments.templateId': { $in: ids } } },
    { $group: { _id: '$rubricAssignments.templateId', jobs: { $addToSet: '$_id' } } },
  ]);

  for (const row of rows) {
    counts.set(String(row._id), row.jobs.length);
  }
  return counts;
};

/**
 * Archive, never delete: a Meeting.rubricSnapshot may point at this template, and the
 * history panel names the rubric a round was scored against.
 */
export const archiveRubricTemplate = async (id, userId) => {
  const doc = await getRubricTemplateById(id);
  if (doc.isDefault) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This is the default rubric. Make another rubric the default before archiving it.'
    );
  }

  /**
   * A job deliberately pointed at this rubric would otherwise fall back to the house
   * default with nobody told (audit J3). Name the jobs — "in use" alone leaves the user
   * hunting for which ones.
   */
  const jobs = await jobsUsingTemplate(doc._id);
  if (jobs.length) {
    const names = jobs.slice(0, 5).map((j) => j.title).join(', ');
    const more = jobs.length > 5 ? ` and ${jobs.length - 5} more` : '';
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${jobs.length} ${jobs.length === 1 ? 'job uses' : 'jobs use'} this rubric: ${names}${more}. Point them at another rubric first.`,
      true,
      '',
      { errorCode: 'rubric_template_in_use' }
    );
  }

  doc.archivedAt = new Date();
  doc.updatedBy = userId;
  await doc.save();
  return doc;
};

export const restoreRubricTemplate = async (id, userId) => {
  const doc = await getRubricTemplateById(id);
  doc.archivedAt = null;
  doc.updatedBy = userId;
  await doc.save();
  return doc;
};
