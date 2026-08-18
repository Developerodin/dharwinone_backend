import mongoose from 'mongoose';
import Task from '../../models/task.model.js';
import Sprint from '../../models/sprint.model.js';
import {
  hasProjectReadAccess,
  hasTeamReadAccess,
  projectIdsForTeam,
  resolveProjectByNameOrId,
  resolveTeamByName,
  sprintsForProject,
  tasksForSprint,
  resolveSprintByNameOrId,
} from './projectGraph.resolvers.js';
import {
  buildAccessibleTaskFilter,
  blockedTaskClause,
  isBlockedTask,
  overdueTaskClause,
  resolveAssigneeByName,
} from './taskAccess.js';
import {
  executeAtomicTaskQuery,
  mapTaskRow,
  buildTaskResultEnvelope,
} from './taskResult.js';
import {
  isTaskStageCountQuery,
  resolveTaskStage,
  stageLabelForStatus,
} from './taskStageVocabulary.js';

export const TASK_BOARD_METRICS = [
  'stage_counts',
  'stage_count',
  'overdue',
  'blocked',
  'by_project',
  'by_assignee',
  'by_team',
  'sprint_summary',
];

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function looksLikeTaskBoardQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (isTaskStageCountQuery(t)) return true;
  if (
    /\b(blocked|overdue|past due|missed deadline|in review|in_review|on[\s_-]?go(?:a)?ing|on_going|ongoing|in progress|kanban|task[\s_-]?board|stage counts?)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(how many|count|which|what)\b.{0,40}\btasks?\b/i.test(t)
    && /\b(blocked|overdue|review|todo|completed|sprint|ongoing|goaing|progress)\b/i.test(t)
  ) {
    return true;
  }
  if (/\bsprints?\b.{0,40}\bproject\b/i.test(t)) return true;
  if (/\btasks?\b.{0,40}\bsprint\b/i.test(t)) return true;
  return false;
}

export function looksLikeTaskBoardContinuation(text, memory = null) {
  const t = String(text || '');
  const topic = (memory?.lastTopic || '').toLowerCase();
  const wasTask = topic === 'task' || topic === 'tasks';
  if (!wasTask && !memory?.projectName && !memory?.lastSprintName && !memory?.lastTaskStage) return false;
  if (/\b(show|list)\b.{0,20}\b(them|those|names?|tasks?)\b/i.test(t) && memory?.lastTaskStage) return true;
  if (/\b(which|what)\b.{0,20}\b(blocked|overdue)\b/i.test(t)) return true;
  if (/\b(blocked|overdue)\b/i.test(t) && (memory?.lastAssigneeName || memory?.person || memory?.projectName)) return true;
  return false;
}

/**
 * @returns {{ metric: string, projectName?: string, teamName?: string, assigneeName?: string, sprintName?: string, status?: string, phrase: string }}
 */
export function extractTaskBoardArgs(text, queryContext = {}) {
  const phrase = String(text || '');
  const out = { metric: 'stage_counts', phrase };

  const stage = resolveTaskStage(phrase, queryContext);
  if (stage.blocked) {
    out.metric = 'blocked';
  } else if (stage.status) {
    out.status = stage.status;
    if (isTaskStageCountQuery(phrase)) out.metric = 'stage_count';
  }

  if (/\boverdue\b/i.test(phrase)) out.metric = 'overdue';
  if (/\bblocked\b/i.test(phrase)) out.metric = 'blocked';

  const sprintOnProject = phrase.match(/\bsprints?\b.{0,30}\b(?:project|on)\s+["']?([^"'.?\n]+)["']?/i);
  if (sprintOnProject) {
    out.metric = 'sprint_summary';
    out.projectName = sprintOnProject[1].trim();
    return out;
  }

  const tasksInSprint = phrase.match(/\btasks?\b.{0,30}\b(?:in|for|on)\s+sprint\s+["']?([^"'.?\n]+)["']?/i);
  if (tasksInSprint) {
    out.metric = 'by_project';
    out.sprintName = tasksInSprint[1].trim();
    return out;
  }

  const projectNamed = phrase.match(/\b(?:tasks?\s+(?:on|for|in)|project)\s+["']?([^"'.?\n]+?)["']?(?:\?|$|\btasks?\b)/i);
  if (projectNamed) {
    out.metric = out.metric === 'stage_counts' ? 'by_project' : out.metric;
    out.projectName = projectNamed[1].trim();
  }

  const assigneeNamed = phrase.match(/\b(?:assigned to|for)\s+["']?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})["']?/i);
  if (assigneeNamed) out.assigneeName = assigneeNamed[1].trim();

  const teamNamed = phrase.match(/\bteam\s+["']?([^"'.?\n]+)["']?\b/i);
  if (teamNamed) {
    out.metric = out.metric === 'stage_counts' ? 'by_team' : out.metric;
    out.teamName = teamNamed[1].trim();
  }

  if (!out.status && stage.status) out.status = stage.status;

  return out;
}

function buildFormattedTaskBoardSummary(payload) {
  const { metric, authoritativeCount, breakdown = {}, rows = [], lookup = null } = payload;
  const lines = [];

  if (metric === 'stage_count' && lookup?.stageLabel) {
    lines.push(`There are **${authoritativeCount}** task(s) in **${lookup.stageLabel}** on the Task Board.`);
    if (rows.length) {
      for (const r of rows.slice(0, 25)) {
        lines.push(`- ${r.title}${r.taskKey ? ` (${r.taskKey})` : ''}`);
      }
    }
    return lines.join('\n');
  }

  if (metric === 'stage_counts') {
    lines.push(`Task board — ${authoritativeCount} open tasks across stages:`);
    for (const [stage, count] of Object.entries(breakdown.byStage || {})) {
      lines.push(`- ${stageLabelForStatus(stage)}: ${count}`);
    }
    return lines.join('\n');
  }

  if (metric === 'overdue') {
    lines.push(`Overdue tasks: ${authoritativeCount}`);
    if (rows.length) {
      lines.push('| Task | Project | Assignee | Due | Status |');
      lines.push('|---|---|---|---|---|');
      for (const r of rows.slice(0, 25)) {
        lines.push(`| ${r.title} | ${r.projectName || '—'} | ${r.assigneeLabel || '—'} | ${r.dueDate || '—'} | ${r.status} |`);
      }
    }
    return lines.join('\n');
  }

  if (metric === 'blocked') {
    lines.push(`Blocked tasks: ${authoritativeCount}`);
    if (rows.length) {
      for (const r of rows.slice(0, 25)) {
        lines.push(`- ${r.title} (${r.projectName || 'no project'}) — ${r.assigneeLabel || 'unassigned'}`);
      }
    }
    return lines.join('\n');
  }

  if (metric === 'sprint_summary' && lookup) {
    lines.push(`Sprints on ${lookup.projectName}: ${lookup.sprints?.length ?? 0}`);
    lines.push('| Sprint | Status | Tasks | Open | Completed |');
    lines.push('|---|---|---|---|---|');
    for (const s of lookup.sprints || []) {
      lines.push(`| ${s.name} | ${s.status} | ${s.taskCount} | ${s.openCount} | ${s.completedCount} |`);
    }
    return lines.join('\n');
  }

  if (rows.length) {
    lines.push(`${metric}: ${authoritativeCount} task(s)`);
    for (const r of rows.slice(0, 25)) {
      lines.push(`- ${r.title} | ${r.status} | ${r.projectName || '—'}`);
    }
  } else {
    lines.push(`No tasks found for ${metric}.`);
  }
  return lines.join('\n');
}

export function buildTaskBoardPayload({
  metric,
  rows = [],
  breakdown = {},
  scope = 'all',
  lookup = null,
  searchedFor = null,
  authoritativeCount = 0,
  provenance = 'task.service.queryTasks + Task.aggregate',
} = {}) {
  const payload = {
    metric,
    authoritative: true,
    authoritativeCount,
    authoritativeLabel: metric,
    provenance,
    scope,
    breakdown,
    rows,
    lookup,
    searchedFor,
    formattedSummary: '',
  };
  payload.formattedSummary = buildFormattedTaskBoardSummary(payload);
  return payload;
}

async function aggregateStageCounts(filter) {
  const pipeline = [
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ];
  const groups = await Task.aggregate(pipeline);
  const byStage = {};
  let total = 0;
  for (const g of groups) {
    byStage[g._id || 'unknown'] = g.count;
    total += g.count;
  }
  return { byStage, total };
}

async function queryTaskRows(user, filter, limit = 50, uiContext = null) {
  const atomic = await executeAtomicTaskQuery(user, {
    filters: filter,
    limit,
    sortBy: '-dueDate',
    uiContext,
  });
  return {
    rows: atomic.result.tasks,
    total: atomic.result.total,
    taskResult: atomic,
  };
}

/**
 * Execute task_board_analytics tool.
 */
export async function fetchTaskBoardAnalytics({ user, args = {}, uiContext = null } = {}) {
  if (!(await hasProjectReadAccess(user))) {
    return {
      forbidden: true,
      reason: 'Missing projects.read / projects.manage permission required to view task board analytics.',
    };
  }

  const inferred = extractTaskBoardArgs(args.phrase || '', { uiContext });
  const metric = String(args.metric || inferred.metric || 'stage_counts').toLowerCase();
  const projectName = args.projectName || inferred.projectName || null;
  const teamName = args.teamName || inferred.teamName || null;
  const assigneeName = args.assigneeName || args.assignee || inferred.assigneeName || null;
  const sprintName = args.sprintName || inferred.sprintName || null;
  const status = args.status || inferred.status || null;

  const { filter: baseFilter, scope } = await buildAccessibleTaskFilter(user, {});

  if (metric === 'sprint_summary') {
    const query = projectName || args.phrase || '';
    const resolved = await resolveProjectByNameOrId(query, user);
    if (resolved.kind === 'notFound') {
      return buildTaskBoardPayload({
        metric,
        rows: [],
        scope,
        searchedFor: query,
        lookup: { notFound: true, projectName: query },
      });
    }
    if (resolved.kind === 'ambiguous') {
      return {
        ambiguous: true,
        searchedFor: query,
        matches: (resolved.matches || []).map((p) => ({ id: String(p._id), name: p.name })),
        authoritative: true,
      };
    }
    const projectId = resolved.project._id || resolved.project.id;
    const sprints = await sprintsForProject(projectId);
    const sprintRows = [];
    for (const s of sprints) {
      const tasks = await tasksForSprint(s._id || s.id);
      sprintRows.push({
        sprintId: String(s._id || s.id),
        name: s.name,
        status: s.status,
        taskCount: tasks.length,
        openCount: tasks.filter((t) => t.status !== 'completed').length,
        completedCount: tasks.filter((t) => t.status === 'completed').length,
      });
    }
    const lookup = {
      projectId: String(projectId),
      projectName: resolved.project.name,
      sprints: sprintRows,
    };
    return buildTaskBoardPayload({
      metric,
      scope,
      lookup,
      authoritativeCount: sprintRows.length,
      provenance: 'Sprint.find + Task.find (project-scoped)',
    });
  }

  const extra = { ...baseFilter };
  if (status) extra.status = status;

  if (projectName) {
    const resolved = await resolveProjectByNameOrId(projectName, user);
    if (resolved.kind === 'notFound') {
      return buildTaskBoardPayload({ metric, rows: [], scope, searchedFor: projectName, authoritativeCount: 0 });
    }
    if (resolved.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: projectName, matches: (resolved.matches || []).map((p) => ({ id: String(p._id), name: p.name })), authoritative: true };
    }
    extra.projectId = resolved.project._id || resolved.project.id;
  }

  if (sprintName) {
    const resolved = await resolveSprintByNameOrId(sprintName, extra.projectId, user);
    if (resolved.kind === 'notFound') {
      return buildTaskBoardPayload({ metric, rows: [], scope, searchedFor: sprintName, authoritativeCount: 0 });
    }
    if (resolved.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: sprintName, matches: (resolved.matches || []).map((s) => ({ id: String(s._id), name: s.name })), authoritative: true };
    }
    extra.sprintId = resolved.sprint._id || resolved.sprint.id;
  }

  if (teamName && (await hasTeamReadAccess(user))) {
    const teamRes = await resolveTeamByName(teamName, user);
    if (teamRes.kind === 'notFound') {
      return buildTaskBoardPayload({ metric, rows: [], scope, searchedFor: teamName, authoritativeCount: 0 });
    }
    if (teamRes.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: teamName, matches: (teamRes.matches || []).map((t) => ({ id: String(t._id), name: t.name })), authoritative: true };
    }
    const pids = await projectIdsForTeam(teamRes.team._id || teamRes.team.id);
    extra.projectId = { $in: pids.map((id) => new mongoose.Types.ObjectId(id)) };
  }

  if (assigneeName) {
    const assignee = await resolveAssigneeByName(assigneeName);
    if (assignee.kind === 'notFound') {
      return buildTaskBoardPayload({ metric, rows: [], scope, searchedFor: assigneeName, authoritativeCount: 0 });
    }
    if (assignee.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: assigneeName, matches: assignee.matches, authoritative: true };
    }
    extra.assignedTo = assignee.userIds[0];
  }

  if (metric === 'overdue') {
    Object.assign(extra, overdueTaskClause());
  }
  if (metric === 'blocked') {
    Object.assign(extra, blockedTaskClause());
  }

  if (metric === 'stage_count' && status) {
    const atomic = await executeAtomicTaskQuery(user, {
      filters: { ...extra, status },
      limit: args.limit || 50,
      sortBy: '-dueDate',
      uiContext,
    });
    const payload = buildTaskBoardPayload({
      metric,
      rows: atomic.result.tasks,
      scope,
      authoritativeCount: atomic.result.total,
      lookup: {
        stage: status,
        stageLabel: stageLabelForStatus(status),
      },
      provenance: atomic.provenance,
    });
    return {
      ...payload,
      ...atomic,
      metric,
      lookup: payload.lookup,
      formattedSummary: payload.formattedSummary,
    };
  }

  if (metric === 'stage_counts') {
    const { byStage, total } = await aggregateStageCounts(extra);
    if (status && byStage[status] != null) {
      const atomic = await executeAtomicTaskQuery(user, {
        filters: { ...extra, status },
        limit: args.limit || 25,
        sortBy: '-dueDate',
        uiContext,
      });
      const payload = buildTaskBoardPayload({
        metric: 'stage_count',
        rows: atomic.result.tasks,
        scope,
        breakdown: { byStage: { [status]: atomic.result.total } },
        authoritativeCount: atomic.result.total,
        lookup: { stage: status, stageLabel: stageLabelForStatus(status) },
        provenance: atomic.provenance,
      });
      return {
        ...payload,
        ...atomic,
        metric: 'stage_count',
        lookup: payload.lookup,
        formattedSummary: payload.formattedSummary,
      };
    }
    return buildTaskBoardPayload({
      metric,
      scope,
      breakdown: { byStage },
      authoritativeCount: total,
      provenance: 'Task.aggregate $group by status',
    });
  }

  const { rows, total, taskResult } = await queryTaskRows(user, extra, args.limit || 50, uiContext);
  const payload = buildTaskBoardPayload({
    metric,
    rows,
    scope,
    authoritativeCount: total,
    searchedFor: projectName || teamName || assigneeName || sprintName || null,
  });
  if (taskResult) {
    return { ...payload, ...taskResult, metric, formattedSummary: payload.formattedSummary };
  }
  return payload;
}

/** Entity hints for conversation memory after task board analytics. */
export function extractTaskBoardMemoryHints(fetched = {}) {
  const out = {};
  const board = fetched.task_board_analytics;
  const workload = fetched.workload_analytics;

  if (board && !board.forbidden) {
    out.lastTopic = 'tasks';
    out.lastScope = board.scope || null;
    if (board.lookup?.projectName) out.projectName = board.lookup.projectName;
    if (board.lookup?.projectId) out.lastProjectId = board.lookup.projectId;
    if (board.lookup?.stage) {
      out.lastTaskStage = board.lookup.stage;
      out.lastTaskStageLabel = board.lookup.stageLabel || stageLabelForStatus(board.lookup.stage);
    }
    if (board.metric === 'stage_count' && Array.isArray(board.rows)) {
      out.lastTaskIds = board.rows.map((r) => r.taskId).filter(Boolean);
      out.lastTaskCount = board.authoritativeCount ?? board.rows.length;
    }
    if (board.searchedFor && board.metric === 'blocked') out.lastTaskFilter = 'blocked';
    if (board.searchedFor && board.metric === 'overdue') out.lastTaskFilter = 'overdue';
    if (board.lookup?.sprints?.[0]?.name) {
      out.lastSprintName = board.lookup.sprints[0].name;
      out.lastSprintId = board.lookup.sprints[0].sprintId;
    }
  }

  if (workload && !workload.forbidden) {
    out.lastTopic = 'tasks';
    out.lastScope = workload.scope || null;
    if (workload.lookup?.assigneeName) out.lastAssigneeName = workload.lookup.assigneeName;
    if (workload.lookup?.teamName) out.lastTeamName = workload.lookup.teamName;
    if (workload.lookup?.projectName) out.projectName = workload.lookup.projectName;
  }

  return out;
}

export { isBlockedTask };
