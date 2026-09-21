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
 * Tenant scope for rubric templates.
 *
 * Superuser/platform bypass matches job-template reads: no tenant clause.
 * Everyone else sees templates stamped with their adminId, plus legacy docs
 * whose tenantId is missing or null (created before stamping). Stamped
 * templates belonging to another adminId never leak.
 */
export const rubricTenantFilter = ({ tenantId = null, bypassTenant = false } = {}) => {
  if (bypassTenant) return {};
  const unscoped = [{ tenantId: null }, { tenantId: { $exists: false } }];
  if (!tenantId) return { $or: unscoped };
  return { $or: [{ tenantId }, ...unscoped] };
};

const tenantClause = (access = {}) => {
  if (!access || (access.tenantId == null && !access.bypassTenant && !access.enforceTenant)) {
    return {};
  }
  return rubricTenantFilter(access);
};

const isImpossibleTenant = (clause) =>
  Boolean(clause?._id && Array.isArray(clause._id.$in) && clause._id.$in.length === 0);

const findScopedTemplate = async (id, access = {}) => {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  const clause = tenantClause(access);
  if (isImpossibleTenant(clause)) return null;
  return RubricTemplate.findOne({ _id: id, ...clause }).lean();
};

const toResolved = (template) => ({
  templateId: template._id,
  templateName: template.name,
  criteria: plainCriteria(template.criteria),
});

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
 *   1. the job's plan row whose `key === planKey` — its own criteria, then its template
 *   2. the job's `rubricAssignments` row for this round type, then the job default row
 *   3. a template whose `appliesTo.roundType` matches
 *   4. the template marked `isDefault`
 *   5. `DEFAULT_RUBRIC_CRITERIA` in code
 *
 * The first rung that matches wins and nothing below it is consulted. Rungs 1–2 come from
 * the job; `appliesTo.jobId` is deliberately NOT consulted any more, so a job's rubric has
 * exactly one place to be set (audit J1).
 *
 * A row pointing at a template resolves that template even when it is archived: a job
 * deliberately assigned a rubric must not silently fall back to the house default because
 * someone tidied up. Archiving a referenced template is refused separately (audit J3).
 *
 * @param {{jobId?: string|null, roundType?: string|null, planKey?: string|null, templateId?: string|null, tenantId?: string|null, bypassTenant?: boolean, enforceTenant?: boolean, strictMissing?: boolean}} target
 * @returns {Promise<{templateId: mongoose.Types.ObjectId|null, templateName: string, criteria: Array<object>}>}
 */
export const resolveRubricForRound = async ({
  jobId = null,
  roundType = null,
  planKey = null,
  templateId = null,
  tenantId = null,
  bypassTenant = false,
  enforceTenant = false,
  strictMissing = false,
} = {}) => {
  const access = { tenantId, bypassTenant, enforceTenant };
  const scoped = tenantClause(access);

  let skipTypeFallback = false;

  if (jobId && mongoose.Types.ObjectId.isValid(jobId)) {
    const job = await Job.findById(jobId).select('rubricAssignments interviewRounds').lean();
    const hasPlan = Array.isArray(job?.interviewRounds) && job.interviewRounds.length > 0;

    /**
     * Rung 1 — the plan row this round was scheduled against (audit R1/R6).
     *
     * Matched on the frozen planKey, never on round type or position: a round type can
     * legitimately repeat across the plan, and an index shifts whenever a round is
     * cancelled and rebooked.
     *
     * A planKey that matches no row falls through rather than throwing. The row can be
     * deleted from the job after a round was already held against it, and that must not
     * stop the next round being scheduled.
     */
    if (planKey) {
      const row = (job?.interviewRounds || []).find((r) => String(r.key) === String(planKey));
      if (row?.criteria?.length) {
        return {
          templateId: null,
          templateName: 'Custom for this round',
          criteria: plainCriteria(row.criteria),
        };
      }
      if (row?.templateId) {
        const template = await findScopedTemplate(row.templateId, access);
        if (template) return toResolved(template);
        if (strictMissing) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Rubric template not found');
        }
        // A planned row named a template that is gone. Do not silently swap in the
        // house default — that is how Other v1 replaced Other v2.
        if (hasPlan) skipTypeFallback = true;
      }
      // A planned row with neither templateId nor criteria may still use catalog
      // defaults. Once a row names a rubric, type / isDefault must not swap it.
    } else if (hasPlan) {
      // Off-plan on a job that already has interviewRounds: type / isDefault are
      // filter-only. An explicit templateId still resolves below.
      skipTypeFallback = true;
    }

    if (!skipTypeFallback) {
      // Rung 2 — legacy: the round-type-keyed assignments this field replaced. Kept so
      // every job that has not been re-saved on the new form keeps resolving (D2).
      const assignment = pickJobAssignment(job?.rubricAssignments, roundType);

      if (assignment?.criteria?.length) {
        return {
          templateId: null,
          templateName: 'Custom for this job',
          criteria: plainCriteria(assignment.criteria),
        };
      }

      if (assignment?.templateId) {
        const template = await findScopedTemplate(assignment.templateId, access);
        if (template) return toResolved(template);
      }
    }
  }

  if (templateId) {
    const template = await findScopedTemplate(templateId, access);
    if (template) return toResolved(template);
    if (strictMissing) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Rubric template not found');
    }
  }

  if (skipTypeFallback) {
    return {
      templateId: null,
      templateName: 'Default rubric',
      criteria: plainCriteria(DEFAULT_RUBRIC_CRITERIA),
    };
  }

  const or = [{ isDefault: true }];
  if (roundType) or.push({ 'appliesTo.roundType': roundType });

  let candidates = [];
  if (!isImpossibleTenant(scoped)) {
    const typeFilter = { archivedAt: null, $or: or };
    const query =
      scoped && Object.keys(scoped).length ? { $and: [typeFilter, scoped] } : typeFilter;
    candidates = await RubricTemplate.find(query).lean();
  }
  const picked = pickMostSpecificTemplate(candidates, { roundType });

  if (!picked) {
    return {
      templateId: null,
      templateName: 'Default rubric',
      criteria: plainCriteria(DEFAULT_RUBRIC_CRITERIA),
    };
  }
  return toResolved(picked);
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
const demoteOtherDefaults = async (keepId, tenantId = null) => {
  const filter = { isDefault: true, archivedAt: null };
  if (keepId) filter._id = { $ne: keepId };
  if (tenantId) filter.tenantId = tenantId;
  else filter.$or = [{ tenantId: null }, { tenantId: { $exists: false } }];
  await RubricTemplate.updateMany(filter, { $set: { isDefault: false } });
};

export const createRubricTemplate = async (body, userId, tenantId = null) => {
  assertValidCriteria(body.criteria);
  const doc = await RubricTemplate.create({
    name: body.name,
    description: body.description || '',
    criteria: plainCriteria(body.criteria),
    appliesTo: {
      jobId: null,
      roundType: body.appliesTo?.roundType || null,
    },
    isDefault: Boolean(body.isDefault),
    createdBy: userId,
    tenantId: tenantId || null,
  });
  if (doc.isDefault) await demoteOtherDefaults(doc._id, doc.tenantId || null);
  return doc;
};

export const getRubricTemplateById = async (id, access = null) => {
  const filter = { _id: id };
  if (access) {
    const clause = rubricTenantFilter(access);
    if (isImpossibleTenant(clause)) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Rubric template not found');
    }
    Object.assign(filter, clause);
  }
  const doc = await RubricTemplate.findOne(filter);
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Rubric template not found');
  return doc;
};

export const queryRubricTemplates = async (filter, options) => RubricTemplate.paginate(filter, options);

export const updateRubricTemplate = async (id, body, userId, access = null) => {
  const doc = await getRubricTemplateById(id, access);
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
      jobId: null,
      roundType: body.appliesTo?.roundType || null,
    };
  }
  if (body.isDefault !== undefined) doc.isDefault = Boolean(body.isDefault);
  doc.updatedBy = userId;
  await doc.save();
  if (doc.isDefault) await demoteOtherDefaults(doc._id, doc.tenantId || null);
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
  // Both arrays: interviewRounds is the write target, rubricAssignments is still read as
  // the resolver's fallback rung, so a template named by either is genuinely in use.
  const rows = await Job.find({
    $or: [{ 'rubricAssignments.templateId': templateId }, { 'interviewRounds.templateId': templateId }],
  })
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
    {
      $match: {
        $or: [
          { 'rubricAssignments.templateId': { $in: ids } },
          { 'interviewRounds.templateId': { $in: ids } },
        ],
      },
    },
    {
      $project: {
        rows: {
          $concatArrays: [
            { $ifNull: ['$rubricAssignments', []] },
            { $ifNull: ['$interviewRounds', []] },
          ],
        },
      },
    },
    { $unwind: '$rows' },
    { $match: { 'rows.templateId': { $in: ids } } },
    { $group: { _id: '$rows.templateId', jobs: { $addToSet: '$_id' } } },
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
export const archiveRubricTemplate = async (id, userId, access = null) => {
  const doc = await getRubricTemplateById(id, access);
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

export const restoreRubricTemplate = async (id, userId, access = null) => {
  const doc = await getRubricTemplateById(id, access);
  doc.archivedAt = null;
  doc.updatedBy = userId;
  await doc.save();
  return doc;
};
