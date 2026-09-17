import httpStatus from 'http-status';
import mongoose from 'mongoose';
import RubricTemplate from '../models/rubricTemplate.model.js';
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

const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

/**
 * Pick the most specific template for a round. PURE — no database, so the precedence
 * rule is testable on its own and the DB query stays a plain "every live template that
 * could apply" fetch.
 *
 * Specificity: job+type 3, job 2, type 1, default 0. A template targeting a DIFFERENT
 * job or a DIFFERENT round type is not a candidate at all, which is why this cannot be
 * expressed as a sort alone.
 *
 * @param {Array<object>} templates
 * @param {{jobId?: string|null, roundType?: string|null}} target
 * @returns {object|null}
 */
export const pickMostSpecificTemplate = (templates, { jobId, roundType } = {}) => {
  const list = Array.isArray(templates) ? templates : [];
  let best = null;
  let bestScore = -1;

  for (const template of list) {
    const tJob = template?.appliesTo?.jobId ?? null;
    const tType = template?.appliesTo?.roundType ?? null;

    if (tJob && !sameId(tJob, jobId)) continue;
    if (tType && tType !== roundType) continue;

    let score;
    if (tJob && tType) score = 3;
    else if (tJob) score = 2;
    else if (tType) score = 1;
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
 * Resolve the rubric a round should be scored against.
 *
 * Falls back to DEFAULT_RUBRIC_CRITERIA so an install that has configured nothing still
 * gets a real weighted form rather than an empty one.
 *
 * @param {{jobId?: string|null, roundType?: string|null}} target
 * @returns {Promise<{templateId: mongoose.Types.ObjectId|null, templateName: string, criteria: Array<object>}>}
 */
export const resolveRubricForRound = async ({ jobId = null, roundType = null } = {}) => {
  const or = [{ isDefault: true }];
  if (roundType) or.push({ 'appliesTo.roundType': roundType });
  if (jobId && mongoose.Types.ObjectId.isValid(jobId)) {
    or.push({ 'appliesTo.jobId': new mongoose.Types.ObjectId(jobId) });
  }

  const candidates = await RubricTemplate.find({ archivedAt: null, $or: or }).lean();
  const picked = pickMostSpecificTemplate(candidates, { jobId, roundType });

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
