import Joi from 'joi';
import { objectId } from './custom.validation.js';

const projectIdParam = {
  params: Joi.object().keys({
    projectId: Joi.string().custom(objectId).required(),
  }),
};

const runIdParam = {
  params: Joi.object().keys({
    runId: Joi.string().custom(objectId).required(),
  }),
};

const TASK_TITLE_MAX = 500;
const TASK_DESC_MAX = 8000;
const TASK_TAG_MAX_LEN = 64;
const TASK_TAGS_MAX = 20;
const TASK_REQUIRED_SKILLS_MAX = 15;
const TASK_BREAKDOWN_MAX_TASKS = 25;
const FEEDBACK_MAX = 2000;
const PRIOR_TASKS_MAX = 25;

const previewTaskBreakdown = {
  ...projectIdParam,
  body: Joi.object().keys({
    extraBrief: Joi.string().trim().allow('').max(8000).optional(),
    feedback: Joi.string().trim().allow('').max(FEEDBACK_MAX).optional(),
    priorTasks: Joi.array()
      .max(PRIOR_TASKS_MAX)
      .items(
        Joi.object()
          .keys({
            title: Joi.string().trim().max(TASK_TITLE_MAX).required(),
            description: Joi.string().trim().allow('').max(TASK_DESC_MAX).optional(),
          })
          .unknown(false)
      )
      .optional(),
  }),
};

const applyTaskBreakdown = {
  ...projectIdParam,
  body: Joi.object().keys({
    tasks: Joi.array()
      .items(
        Joi.object()
          .keys({
            title: Joi.string().trim().min(1).max(TASK_TITLE_MAX).required(),
            description: Joi.string().trim().allow('').max(TASK_DESC_MAX).optional(),
            status: Joi.string().valid('new', 'todo', 'on_going', 'in_review', 'completed').optional(),
            tags: Joi.array()
              .max(TASK_TAGS_MAX)
              .items(Joi.string().trim().max(TASK_TAG_MAX_LEN))
              .optional(),
            requiredSkills: Joi.array()
              .max(TASK_REQUIRED_SKILLS_MAX)
              .items(Joi.string().trim().max(TASK_TAG_MAX_LEN))
              .optional(),
            /** Model may send floats; service floors to integer. */
            order: Joi.number().min(0).max(1000000).optional(),
          })
          /** Preview JSON often includes extra keys (e.g. rationale); service ignores them. */
          .unknown(true)
      )
      .min(1)
      .max(TASK_BREAKDOWN_MAX_TASKS)
      .required(),
  }),
};

const patchAssignmentRun = {
  params: Joi.object().keys({
    runId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object().keys({
    rows: Joi.array()
      .items(
        Joi.object().keys({
          id: Joi.string().custom(objectId).optional(),
          _id: Joi.string().custom(objectId).optional(),
          recommendedCandidateId: Joi.string().custom(objectId).allow(null).optional(),
          gap: Joi.boolean().optional(),
          notes: Joi.string().trim().allow('').max(2000).optional(),
        })
      )
      .required(),
  }),
};

const assignmentRowJobDraft = {
  params: Joi.object().keys({
    runId: Joi.string().custom(objectId).required(),
    rowId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      force: Joi.boolean().optional(),
    })
    .default({}),
};

const bootstrapSmartTeam = {
  ...projectIdParam,
  body: Joi.object().keys({
    extraBrief: Joi.string().trim().allow('').max(8000).optional(),
  }),
};

const BRIEF_HTML_IN_MAX = 50000;
const BRIEF_CONTEXT_MAX = 500;

const enhanceProjectBrief = {
  body: Joi.object()
    .keys({
      html: Joi.string().allow('').max(BRIEF_HTML_IN_MAX).required(),
      projectName: Joi.string().trim().allow('').max(BRIEF_CONTEXT_MAX).optional(),
      projectManager: Joi.string().trim().allow('').max(BRIEF_CONTEXT_MAX).optional(),
      clientStakeholder: Joi.string().trim().allow('').max(BRIEF_CONTEXT_MAX).optional(),
      previousEnhancedHtml: Joi.string().allow('').max(BRIEF_HTML_IN_MAX).optional(),
      refinementInstructions: Joi.string().trim().allow('').max(4000).optional(),
      feedback: Joi.object()
        .keys({
          rating: Joi.string().valid('up', 'down').optional(),
          comment: Joi.string().trim().allow('').max(800).optional(),
        })
        .optional(),
    })
    .required(),
};

export {
  previewTaskBreakdown,
  applyTaskBreakdown,
  bootstrapSmartTeam,
  enhanceProjectBrief,
  projectIdParam,
  runIdParam,
  patchAssignmentRun,
  assignmentRowJobDraft,
};
