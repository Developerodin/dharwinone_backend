import createTaskPlan from './createTaskPlan.tool.js';

export const instructions = [
  'Task plans: "break project X into tasks", "plan / generate the tasks for project X" → create_task_plan with the ' +
    "project as the user named it and any extra direction as brief. It only drafts; say the plan is ready to " +
    'review and confirm, never that the tasks were created.',
  '- Listing or counting existing tasks is not a plan: use the projects tools. Assigning people to tasks is not ' +
    'supported here: handoff.',
].join('\n');

export const tools = [createTaskPlan];
