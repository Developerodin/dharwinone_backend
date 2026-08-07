import mongoose from 'mongoose';
import Task from '../../models/task.model.js';
import Employee from '../../models/employee.model.js';
import User from '../../models/user.model.js';
import { enrichTeamMembersWithAssignedTaskCounts } from '../team.service.js';
import {
  hasProjectReadAccess,
  hasTeamReadAccess,
  projectIdsForTeam,
  resolveProjectByNameOrId,
  resolveTeamByName,
  fetchAccessibleProjects,
} from './projectGraph.resolvers.js';
import {
  buildAccessibleTaskFilter,
  overdueTaskClause,
  resolveAssigneeByName,
  OPEN_TASK_STATUSES,
  OVERLOAD_TASK_THRESHOLD,
} from './taskAccess.js';

export const WORKLOAD_METRICS = [
  'employee_tasks',
  'employee_projects',
  'team_member_workload',
  'team_workload',
  'overload',
  'overdue_by_employee',
  'most_tasks',
  'team_utilization',
  'cross_project_summary',
];

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function looksLikeWorkloadQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\b(who has (the )?most tasks?|most tasks?|highest workload|overload|overloaded|team workload|workload|utilization|capacity)\b/i.test(t)) return true;
  if (/\b(tasks? per (employee|member|person)|employee tasks?|member workload)\b/i.test(t)) return true;
  if (/\bwhich team\b.{0,40}\b(workload|tasks?|utilization)\b/i.test(t)) return true;
  return false;
}

export function looksLikeWorkloadContinuation(text, memory = null) {
  const t = String(text || '');
  if (/\bwho has\b.{0,20}\bmost tasks?\b/i.test(t)) return true;
  if (/\b(most tasks?|highest workload)\b/i.test(t) && (memory?.lastTeamName || memory?.projectName)) return true;
  return false;
}

/**
 * @returns {{ metric: string, assigneeName?: string, teamName?: string, projectName?: string, phrase: string }}
 */
export function extractWorkloadArgs(text) {
  const phrase = String(text || '');
  const out = { metric: 'most_tasks', phrase };

  if (/\bteam utilization\b/i.test(phrase) || /\butilization\b/i.test(phrase)) {
    out.metric = 'team_utilization';
  } else if (/\bcross[\s-]?project\b/i.test(phrase)) {
    out.metric = 'cross_project_summary';
  } else if (/\boverload/i.test(phrase)) {
    out.metric = 'overload';
  } else if (/\boverdue\b/i.test(phrase) && /\b(employee|person|member|by)\b/i.test(phrase)) {
    out.metric = 'overdue_by_employee';
  } else if (/\bteam member\b/i.test(phrase) || /\bper member\b/i.test(phrase)) {
    out.metric = 'team_member_workload';
  } else if (/\bteam workload\b/i.test(phrase) || /\bwhich team\b/i.test(phrase)) {
    out.metric = 'team_workload';
  } else if (/\bprojects?\b/i.test(phrase) && /\b(on|for|assigned)\b/i.test(phrase)) {
    out.metric = 'employee_projects';
  } else if (/\bwho has\b/i.test(phrase) || /\bmost tasks?\b/i.test(phrase)) {
    out.metric = 'most_tasks';
  } else if (/\bemployee tasks?\b/i.test(phrase)) {
    out.metric = 'employee_tasks';
  }

  const assigneeNamed = phrase.match(/\b(?:for|of)\s+["']?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})["']?/i);
  if (assigneeNamed) out.assigneeName = assigneeNamed[1].trim();

  const teamNamed = phrase.match(/\bteam\s+["']?([^"'.?\n]+)["']?\b/i);
  if (teamNamed) out.teamName = teamNamed[1].trim();

  const projectNamed = phrase.match(/\bproject\s+["']?([^"'.?\n]+)["']?\b/i);
  if (projectNamed) out.projectName = projectNamed[1].trim();

  return out;
}

function buildFormattedWorkloadSummary(payload) {
  const { metric, rows = [], lookup = null, authoritativeCount = 0, breakdown = {} } = payload;
  const lines = [];

  if (metric === 'most_tasks' && rows.length) {
    const top = rows[0];
    lines.push(`Most tasks: ${top.name} — ${top.openCount} open (${top.totalCount} total)`);
    lines.push('| Person | Open | Total |');
    lines.push('|---|---|---|');
    for (const r of rows.slice(0, 10)) {
      lines.push(`| ${r.name} | ${r.openCount} | ${r.totalCount} |`);
    }
    return lines.join('\n');
  }

  if (metric === 'team_utilization' && lookup) {
    lines.push(`Team ${lookup.teamName} — ${lookup.activeTasks} active tasks, ${lookup.overdueCount} overdue`);
    lines.push(`Completion: ${lookup.completionPct}% | Avg tasks/member: ${lookup.avgTasksPerMember}`);
    if (lookup.byProject?.length) {
      lines.push('By project:');
      for (const p of lookup.byProject) {
        lines.push(`- ${p.projectName}: ${p.openCount} open / ${p.totalCount} total`);
      }
    }
    return lines.join('\n');
  }

  if (metric === 'team_member_workload' && rows.length) {
    lines.push(`Team member workload (${lookup?.teamName || 'team'}):`);
    lines.push('| Member | Tasks |');
    lines.push('|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.name} | ${r.tasksAssignedCount ?? r.openCount ?? 0} |`);
    }
    return lines.join('\n');
  }

  if (metric === 'overload') {
    lines.push(`Overloaded members (≥${OVERLOAD_TASK_THRESHOLD} open tasks): ${authoritativeCount}`);
    for (const r of rows) {
      lines.push(`- ${r.name}: ${r.openCount} open tasks`);
    }
    return lines.join('\n');
  }

  if (rows.length) {
    lines.push(`${metric}: ${authoritativeCount} result(s)`);
    for (const r of rows.slice(0, 15)) {
      lines.push(`- ${r.name || r.title}: ${r.openCount ?? r.count ?? 0}`);
    }
  } else {
    lines.push(`No workload data for ${metric}.`);
  }
  return lines.join('\n');
}

export function buildWorkloadPayload({
  metric,
  rows = [],
  breakdown = {},
  scope = 'all',
  lookup = null,
  searchedFor = null,
  authoritativeCount = 0,
  provenance = 'Task.aggregate + team.service.enrichTeamMembersWithAssignedTaskCounts',
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
  payload.formattedSummary = buildFormattedWorkloadSummary(payload);
  return payload;
}

async function aggregateTasksByAssignee(filter, { openOnly = false } = {}) {
  const match = { ...filter };
  if (openOnly) match.status = { $in: OPEN_TASK_STATUSES };

  const pipeline = [
    { $match: match },
    { $unwind: '$assignedTo' },
    {
      $group: {
        _id: '$assignedTo',
        totalCount: { $sum: 1 },
        openCount: {
          $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] },
        },
      },
    },
    { $sort: { openCount: -1, totalCount: -1 } },
    { $limit: 50 },
  ];
  return Task.aggregate(pipeline);
}

async function hydrateAssigneeRows(groups) {
  if (!groups.length) return [];
  const userIds = groups.map((g) => g._id);
  const [users, employees] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name email').lean(),
    Employee.find({ owner: { $in: userIds } }).select('fullName employeeId owner').lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const empByOwner = new Map(employees.map((e) => [String(e.owner), e]));

  return groups.map((g) => {
    const id = String(g._id);
    const u = userById.get(id);
    const e = empByOwner.get(id);
    return {
      userId: id,
      name: e?.fullName || u?.name || 'Unknown',
      employeeId: e?.employeeId || null,
      openCount: g.openCount,
      totalCount: g.totalCount,
    };
  });
}

async function teamUtilizationStats(teamId, teamName, projectIds, user, memberCount = 1) {
  const pids = projectIds.map((id) => new mongoose.Types.ObjectId(id));
  const baseMatch = { projectId: { $in: pids } };
  const [totalTasks, openTasks, overdueTasks, completedTasks, byProjectAgg] = await Promise.all([
    Task.countDocuments(baseMatch),
    Task.countDocuments({ ...baseMatch, status: { $in: OPEN_TASK_STATUSES } }),
    Task.countDocuments({ ...baseMatch, ...overdueTaskClause() }),
    Task.countDocuments({ ...baseMatch, status: 'completed' }),
    Task.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$projectId', totalCount: { $sum: 1 }, openCount: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } } } },
    ]),
  ]);

  const { projects } = await fetchAccessibleProjects(user, { limit: 200 });
  const projectNameById = new Map((projects || []).map((p) => [String(p._id), p.name]));

  const byProject = [];
  for (const row of byProjectAgg) {
    byProject.push({
      projectId: String(row._id),
      projectName: projectNameById.get(String(row._id)) || 'Unknown',
      totalCount: row.totalCount,
      openCount: row.openCount,
    });
  }

  const completionPct = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return {
    teamId: String(teamId),
    teamName,
    activeTasks: openTasks,
    overdueCount: overdueTasks,
    totalTasks,
    completedTasks,
    completionPct,
    avgTasksPerMember: memberCount ? Math.round((openTasks / memberCount) * 10) / 10 : openTasks,
    memberCount,
    byProject,
  };
}

/**
 * Execute workload_analytics tool.
 */
export async function fetchWorkloadAnalytics({ user, args = {} } = {}) {
  if (!(await hasProjectReadAccess(user))) {
    return {
      forbidden: true,
      reason: 'Missing projects.read / projects.manage permission required to view workload analytics.',
    };
  }

  const inferred = extractWorkloadArgs(args.phrase || '');
  const metric = String(args.metric || inferred.metric || 'most_tasks').toLowerCase();
  const assigneeName = args.assigneeName || args.assignee || inferred.assigneeName || null;
  const teamName = args.teamName || args.team || inferred.teamName || null;
  const projectName = args.projectName || inferred.projectName || null;

  const { filter: baseFilter, scope } = await buildAccessibleTaskFilter(user, {});

  if (metric === 'team_member_workload' || metric === 'team_workload' || metric === 'team_utilization' || metric === 'cross_project_summary') {
    if (!teamName) {
      return buildWorkloadPayload({
        metric,
        rows: [],
        scope,
        authoritativeCount: 0,
        searchedFor: 'team name required',
      });
    }
    if (!(await hasTeamReadAccess(user))) {
      return { forbidden: true, reason: 'Missing teams.read permission for team workload analytics.' };
    }
    const teamRes = await resolveTeamByName(teamName, user);
    if (teamRes.kind === 'notFound') {
      return buildWorkloadPayload({ metric, rows: [], scope, searchedFor: teamName, authoritativeCount: 0 });
    }
    if (teamRes.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: teamName, matches: (teamRes.matches || []).map((t) => ({ id: String(t._id), name: t.name })), authoritative: true };
    }
    const teamId = teamRes.team._id || teamRes.team.id;
    const pids = await projectIdsForTeam(teamId);

    if (metric === 'team_member_workload') {
      const members = teamRes.members || [];
      const withCounts = await enrichTeamMembersWithAssignedTaskCounts(members, { teamId: String(teamId) });
      const rows = withCounts.map((m) => {
        const emp = m.employeeId;
        const name = (emp && typeof emp === 'object' ? emp.fullName : null) || m.displayName || 'Unknown';
        return { name, tasksAssignedCount: m.tasksAssignedCount ?? 0 };
      });
      return buildWorkloadPayload({
        metric,
        rows,
        scope,
        authoritativeCount: rows.reduce((s, r) => s + (r.tasksAssignedCount || 0), 0),
        lookup: { teamName: teamRes.team.name, teamId: String(teamId) },
        provenance: 'team.service.enrichTeamMembersWithAssignedTaskCounts',
      });
    }

    if (metric === 'team_utilization' || metric === 'cross_project_summary') {
      const memberCount = (teamRes.members || []).length || 1;
      const lookup = await teamUtilizationStats(teamId, teamRes.team.name, pids, user, memberCount);
      return buildWorkloadPayload({
        metric,
        rows: lookup.byProject,
        scope,
        authoritativeCount: lookup.activeTasks,
        lookup,
        provenance: 'Task.aggregate across team projects + member counts',
      });
    }

    // team_workload — total open tasks on team's projects
    const openCount = await Task.countDocuments({
      ...baseFilter,
      projectId: { $in: pids.map((id) => new mongoose.Types.ObjectId(id)) },
      status: { $in: OPEN_TASK_STATUSES },
    });
    return buildWorkloadPayload({
      metric,
      rows: [{ name: teamRes.team.name, openCount }],
      scope,
      authoritativeCount: openCount,
      lookup: { teamName: teamRes.team.name, teamId: String(teamId), openCount },
    });
  }

  if (metric === 'employee_projects' && assigneeName) {
    const assignee = await resolveAssigneeByName(assigneeName);
    if (assignee.kind !== 'found') {
      return assignee.kind === 'ambiguous'
        ? { ambiguous: true, searchedFor: assigneeName, matches: assignee.matches, authoritative: true }
        : buildWorkloadPayload({ metric, rows: [], scope, searchedFor: assigneeName, authoritativeCount: 0 });
    }
    const userOid = new mongoose.Types.ObjectId(assignee.userIds[0]);
    const projectIds = await Task.distinct('projectId', { assignedTo: userOid, projectId: { $ne: null } });
    const { projects } = await fetchAccessibleProjects(user, { limit: 200 });
    const rows = projects
      .filter((p) => projectIds.some((id) => String(id) === String(p._id)))
      .map((p) => ({ name: p.name, projectId: String(p._id), status: p.status }));
    return buildWorkloadPayload({
      metric,
      rows,
      scope,
      authoritativeCount: rows.length,
      lookup: { assigneeName: assignee.match.name, userId: assignee.userIds[0] },
    });
  }

  const filter = { ...baseFilter };
  if (projectName) {
    const resolved = await resolveProjectByNameOrId(projectName, user);
    if (resolved.kind === 'found') {
      filter.projectId = resolved.project._id || resolved.project.id;
    }
  }
  if (assigneeName) {
    const assignee = await resolveAssigneeByName(assigneeName);
    if (assignee.kind === 'found') {
      filter.assignedTo = assignee.userIds[0];
    } else if (assignee.kind === 'ambiguous') {
      return { ambiguous: true, searchedFor: assigneeName, matches: assignee.matches, authoritative: true };
    }
  }
  if (metric === 'overdue_by_employee') {
    Object.assign(filter, overdueTaskClause());
  }

  const openOnly = ['overload', 'most_tasks', 'overdue_by_employee'].includes(metric);
  const groups = await aggregateTasksByAssignee(filter, { openOnly });
  let rows = await hydrateAssigneeRows(groups);

  if (metric === 'overload') {
    rows = rows.filter((r) => r.openCount >= OVERLOAD_TASK_THRESHOLD);
  }
  if (metric === 'most_tasks') {
    rows = rows.sort((a, b) => b.openCount - a.openCount || b.totalCount - a.totalCount);
  }

  return buildWorkloadPayload({
    metric,
    rows,
    scope,
    authoritativeCount: metric === 'most_tasks' && rows.length ? rows[0].openCount : rows.length,
    lookup: {
      assigneeName: assigneeName || (rows[0]?.name ?? null),
      teamName: teamName || null,
      projectName: projectName || null,
    },
    breakdown: { threshold: OVERLOAD_TASK_THRESHOLD },
  });
}
