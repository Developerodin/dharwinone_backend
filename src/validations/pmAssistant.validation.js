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
const TASK_BREAKDOWN_MAX_TASKS = 30;
const FEEDBACK_MAX = 1000;
const PRIOR_TASKS_MAX = 30;
const ASSIGNMENT_ROW_NOTES_MAX = 500;

const breakdownContext = Joi.object()
  .keys({
    projectType: Joi.string()
      .valid('software', 'marketing', 'operations', 'research', 'design', 'other')
      .required(),
    deadline: Joi.string().trim().max(32).optional(),
    teamSizeHint: Joi.string().valid('1-3', '4-8', '9+').optional(),
    keyDeliverables: Joi.array().max(10).items(Joi.string().trim().max(80)).optional(),
    constraints: Joi.array()
      .items(
        Joi.string().valid(
          'budget_cap',
          'specific_people',
          'fixed_tech_stack',
          'regulatory_compliance',
          'external_dependency',
          'hard_deadline'
        )
      )
      .optional(),
    extraNotes: Joi.string().trim().allow('').max(500).optional(),
  })
  .unknown(true);

const previewTaskBreakdown = {
  ...projectIdParam,
  body: Joi.object().keys({
    breakdownContext: breakdownContext.optional(),
    extraBrief: Joi.string().trim().allow('').max(2000).optional(),
    feedback: Joi.string().trim().allow('').max(FEEDBACK_MAX).optional(),
    priorTasks: Joi.array()
      .max(PRIOR_TASKS_MAX)
      .items(
        Joi.object()
          .keys({
            id: Joi.string().trim().max(64).optional(),
            title: Joi.string().trim().max(TASK_TITLE_MAX).required(),
            description: Joi.string().trim().allow('').max(TASK_DESC_MAX).optional(),
            status: Joi.string().trim().max(32).optional(),
          })
          .unknown(false)
      )
      .optional(),
  }),
};

const breakdownContextOverride = Joi.object()
  .keys({
    projectType: Joi.string()
      .valid('software', 'marketing', 'operations', 'research', 'design', 'other')
      .optional(),
    deadline: Joi.string().trim().max(32).optional().allow(''),
    teamSizeHint: Joi.string().valid('1-3', '4-8', '9+').optional().allow(null, ''),
    keyDeliverables: Joi.array().max(10).items(Joi.string().trim().max(80)).optional(),
    constraints: Joi.array()
      .items(
        Joi.string().valid(
          'budget_cap',
          'specific_people',
          'fixed_tech_stack',
          'regulatory_compliance',
          'external_dependency',
          'hard_deadline'
        )
      )
      .optional(),
    extraNotes: Joi.string().trim().allow('').max(500).optional(),
  })
  .unknown(true);

const refineTaskBreakdown = {
  ...projectIdParam,
  body: Joi.object()
    .keys({
      previousPreviewId: Joi.string().trim().uuid().required(),
      feedback: Joi.string().trim().min(1).max(FEEDBACK_MAX).required(),
      lockedTaskIds: Joi.array().max(40).items(Joi.string().trim().max(64)).optional(),
      breakdownContextOverride: breakdownContextOverride.optional(),
    })
    .required(),
};

const applyTaskBreakdown = {
  ...projectIdParam,
  body: Joi.object().keys({
    previewId: Joi.string().trim().uuid().optional(),
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
          notes: Joi.string().trim().allow('').max(ASSIGNMENT_ROW_NOTES_MAX).optional(),
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
    extraBrief: Joi.string().trim().allow('').max(2000).optional(),
    breakdownContext: breakdownContext.optional(),
  }),
};

const assignmentRunFeedback = {
  params: Joi.object().keys({
    projectId: Joi.string().custom(objectId).required(),
    runId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      items: Joi.array()
        .min(1)
        .max(50)
        .items(
          Joi.object()
            .keys({
              taskId: Joi.string().trim().required(),
              suggestedEmployeeId: Joi.string().trim().required(),
              outcome: Joi.string().valid('approved', 'rejected', 'replaced').required(),
              replacedWithEmployeeId: Joi.string().trim().allow('').optional(),
              rejectionReason: Joi.string()
                .valid('skill_gap', 'capacity', 'seniority_mismatch', 'preference', 'conflict_of_interest', 'other')
                .optional(),
              note: Joi.string().trim().allow('').max(200).optional(),
            })
            .required()
        )
        .required(),
      submittedAt: Joi.string().trim().optional(),
    })
    .required(),
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
  refineTaskBreakdown,
  applyTaskBreakdown,
  bootstrapSmartTeam,
  enhanceProjectBrief,
  projectIdParam,
  runIdParam,
  patchAssignmentRun,
  assignmentRowJobDraft,
  assignmentRunFeedback,
};
