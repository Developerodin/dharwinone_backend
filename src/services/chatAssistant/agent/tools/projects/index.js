import countProjects from './countProjects.tool.js';
import listProjects from './listProjects.tool.js';
import listTeams from './listTeams.tool.js';
import countTasks from './countTasks.tool.js';
import listTasks from './listTasks.tool.js';
import getWorkload from './getWorkload.tool.js';
import getAllocation from './getAllocation.tool.js';

const instructions = [
  'Projects & tasks: projects (Projects page), workforce teams (Teams page) and tasks (Task Board).',
  '- "How many projects" → count_projects; "list / which projects", "which team is on project X" → list_projects.',
  '- "How many teams", "who is in team X" (includeMembers), "idle teams" (idleOnly) → list_teams. A workforce ' +
    'team is not a department or an org-chart unit.',
  '- Task stage counts ("how many tasks are in review / blocked / overdue / todo / ongoing", "task board ' +
    'summary") → count_tasks, with groupBy "status" for a breakdown. "Which tasks…" → list_tasks.',
  '- "My tasks" → filters.assignedToMe. "His / her / their tasks" → filters.assigneeName with that person\'s ' +
    'real name from the conversation, never the pronoun; if no person was discussed, ask who.',
  '- Task cards use one schema: Task, Stage, Due, Assignees. Do not emit a second table or list with other ' +
    'headers (Due date, Status, Assigned, Project). createdAt on a list_tasks row is when the task was ' +
    'created. If createdAt is null, say the creation date is unavailable. updatedAt is the last update, ' +
    'not the creation date.',
  '- Each list_tasks row includes the creator\'s name, createdAt, updatedAt, commentsCount and attachmentsCount. ' +
    'lastComment is { by, at, text } (text at most 200 characters) only when commentsVisible is true — that is ' +
    'the Task Board comment API (tasks.read or kanban.read). When commentsVisible is false, lastComment is null: ' +
    'do not quote comment text and do not repeat names or emails that appear only in comments. A null creator ' +
    'name means the name is not captured.',
  '- "Why is this task overdue?" → list_tasks (the task code, or filters.overdue). DharwinOne does not store an ' +
    'overdue reason. Answer from the due date, status, last update and the latest comment, and say the reason ' +
    'is not captured unless that comment states it.',
  '- "Tasks created by X" → filters.createdBy with that person\'s real name (list_tasks or count_tasks). ' +
    '"No updates in 7 days" → filters.noUpdateDays 7. "Today\'s task activity" → filters.updatedSince set to ' +
    'today\'s date (YYYY-MM-DD). "Tasks with / without comments" → filters.hasComments true or false.',
  '- Each list_projects row includes createdAt (the project record\'s creation time), the creator\'s name, ' +
    'description (at most 300 characters), members (names of people in assignedTo) and lastActivityAt ' +
    '(latest task updatedAt in that project). createdAt is never lastActivityAt or updatedAt. If createdAt ' +
    'is null, say the creation date is unavailable — do not substitute another date. A null description, ' +
    'creator name or lastActivityAt is not captured — lastActivityAt null means no task update is stored. ' +
    '"Projects with no activity in N days" → list_projects filters.inactiveDays N. Who joined or ' +
    'left a project is not captured.',
  '- "Who has the most tasks", team workload / utilization → get_workload. "Who has more than N open tasks" ' +
    '(an explicit threshold) → get_allocation mode list, bucket "overloaded", overloadAbove N.',
  '- "Who is on no / one / two projects", "who is free / on the bench / unallocated", "who has no active ' +
    'tasks", "how many people are at the project limit" → get_allocation (summary for counts, list + bucket ' +
    'for names). "Can X be put on project Y" → get_allocation mode can_assign; answer with eligible and reason.',
  '- A result with notFound / ambiguous: say what was not found or list the matches and ask which one — never "0".',
  '- Meetings, interviews, attendance, leave, shifts and holidays are not tasks: handoff.',
].join('\n');

export default {
  domain: 'projects',
  summary: 'Projects, teams, Task Board tasks (creator, comments, activity), workload and the max-2-projects rule.',
  instructions,
  tools: [countProjects, listProjects, listTeams, countTasks, listTasks, getWorkload, getAllocation],
};
