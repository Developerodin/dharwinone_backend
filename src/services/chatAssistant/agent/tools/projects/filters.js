import Joi from 'joi';
import { TASK_STATUSES, TASK_PRIORITIES } from '../../../../../models/task.model.js';

const PROJECT_STATUSES = ['Inprogress', 'On hold', 'completed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const projectFilters = Joi.object({
  search: Joi.string().min(1).description('Project name, manager, client, tag or assigned team name (partial match).'),
  status: Joi.string().valid(...PROJECT_STATUSES).description('"active" / "in progress" = Inprogress.'),
  priority: Joi.string().valid(...PRIORITIES),
  teamAssignment: Joi.string().valid('assigned', 'unassigned').description('Projects with / without a workforce team.'),
}).description('Project filters (Projects page).');

export const taskFilters = Joi.object({
  assignedToMe: Joi.boolean().description('Only the signed-in user\'s own tasks ("my tasks").'),
  assigneeName: Joi.string().min(1)
    .description('The assignee\'s real name. NEVER a pronoun — resolve "his/her/their tasks" from the conversation first.'),
  assigneeUserId: Joi.string().min(1).description('The assignee\'s user id (from get_user / list_users).'),
  projectName: Joi.string().min(1).description('Project name (partial match, within projects the viewer can see).'),
  projectId: Joi.string().min(1),
  teamName: Joi.string().min(1).description('Workforce team name — tasks on that team\'s projects.'),
  sprintName: Joi.string().min(1),
  status: Joi.string().valid(...TASK_STATUSES)
    .description('Board stage: new, todo, on_going (ongoing / in progress), in_review, completed (done).'),
  priority: Joi.string().valid(...TASK_PRIORITIES),
  overdue: Joi.boolean().description('Due before today and not completed.'),
  blocked: Joi.boolean().description('Tagged "blocked".'),
  unassigned: Joi.boolean().description('No assignee.'),
  noDueDate: Joi.boolean().description('No due date set.'),
  dueBetween: Joi.object({
    from: Joi.string().min(10).max(10).description('YYYY-MM-DD, inclusive'),
    to: Joi.string().min(10).max(10).description('YYYY-MM-DD, inclusive'),
  }).description('Due date window ("due this week").'),
  search: Joi.string().min(1).description('Task title, description, task code or tag.'),
}).description('Task filters (Task Board).');
