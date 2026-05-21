/**
 * Shared PM-assistant task-breakdown limits.
 *
 * Single source of truth so the generation service (pmAssistant.service.js)
 * and the request validator (validations/pmAssistant.validation.js) cannot
 * drift apart. Defining them here (a leaf module with no imports) avoids the
 * import cycle that would result from the validation layer importing the
 * heavyweight service module.
 */

/**
 * Per-batch preview size: the maximum number of NEW tasks a single
 * preview/refine round may generate or carry as a draft.
 */
export const TASK_BREAKDOWN_PREVIEW_MAX = 60;

/**
 * True product ceiling: the maximum number of tasks a full multi-batch
 * preview can accumulate, and therefore the maximum the apply payload
 * (tasks array, lockedTaskIds, priorTasks) may legitimately contain.
 */
export const HARD_TASK_CEILING = 180;
