import countProjects from './countProjects.tool.js';
import listProjects from './listProjects.tool.js';
import listTeams from './listTeams.tool.js';
import countTasks from './countTasks.tool.js';
import listTasks from './listTasks.tool.js';
import getWorkload from './getWorkload.tool.js';

const instructions = [
  'Projects & tasks: projects (Projects page), workforce teams (Teams page) and tasks (Task Board).',
  '- "How many projects" → count_projects; "list / which projects", "which team is on project X" → list_projects.',
  '- "How many teams", "who is in team X" (includeMembers), "idle teams" (idleOnly) → list_teams. A workforce ' +
    'team is not a department or an org-chart unit.',
  '- Task stage counts ("how many tasks are in review / blocked / overdue / todo / ongoing", "task board ' +
    'summary") → count_tasks, with groupBy "status" for a breakdown. "Which tasks…" → list_tasks.',
  '- "My tasks" → filters.assignedToMe. "His / her / their tasks" → filters.assigneeName with that person\'s ' +
    'real name from the conversation, never the pronoun; if no person was discussed, ask who.',
  '- "Who has the most tasks", "who is overloaded", team workload / utilization → get_workload.',
  '- A result with notFound / ambiguous: say what was not found or list the matches and ask which one — never "0".',
  '- Meetings, interviews, attendance, leave, shifts and holidays are not tasks: handoff.',
].join('\n');

const PROJECT_TASK_RE = /\b(projects?|tasks?|task\s*board|kanban|sprints?|workload|overloaded|utili[sz]ation|backlog)\b/i;
// A bare "team" is the employees domain's word ("team members") — only whole-team phrasings match here.
const TEAM_RE = /\b(how many teams|list (?:the |all )?teams|(?:which|what) teams?|teams? (?:list|lead|roster)|idle teams?|in team\s+\w+|workforce teams?)\b/i;
// Turns other domains own even when they mention a task or project.
const NOT_OURS_RE = /\b(attendance|leaves?|holidays?|shifts?|org[\s-]?chart|meetings?|interviews?)\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  if (NOT_OURS_RE.test(t)) return false;
  return PROJECT_TASK_RE.test(t) || TEAM_RE.test(t);
}

export default {
  domain: 'projects',
  instructions,
  tools: [countProjects, listProjects, listTeams, countTasks, listTasks, getWorkload],
  matchesTurn,
};
