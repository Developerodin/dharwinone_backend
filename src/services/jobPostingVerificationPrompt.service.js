import {
  JOB_WELCOME_TEMPLATE,
  substituteJobTemplateVars,
  buildJobPostingAgentTemplateVars,
} from './jobPostingAgentTemplate.service.js';

// Re-exported so the static-template pair stays importable from the prompt service,
// which is where every existing caller and test already looks.
export {
  buildJobPostingAgentPromptTemplate,
  buildJobPostingAgentTemplateVars,
  substituteJobTemplateVars,
  JOB_WELCOME_TEMPLATE,
} from './jobPostingAgentTemplate.service.js';

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

/**
 * Opening line for job-posting verification call.
 * Delivered as Bolna agent_welcome_message on call connect.
 * Short, warm, TTS-safe — no em dashes or symbols.
 * @param {Object} job - Job doc or lean object
 */
export function resolveJobPostingAgentGreeting(job, opts = {}) {
  // The welcome message is PATCHed onto the agent, so it is shared state exactly like the
  // system prompt. `raw` returns it with placeholders intact — that is what the live call
  // path PATCHes; Bolna fills them from this call's user_data.
  if (opts.raw) return JOB_WELCOME_TEMPLATE;
  const { vars } = buildJobPostingAgentTemplateVars(job);
  return substituteJobTemplateVars(JOB_WELCOME_TEMPLATE, vars);
}
