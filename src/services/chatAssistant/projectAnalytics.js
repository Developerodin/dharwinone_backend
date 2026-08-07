import {
  buildProjectTeamTable,
  enrichProjectsWithTeams,
  fetchAccessibleProjects,
  hasProjectReadAccess,
  hasTeamReadAccess,
  projectIdsForTeam,
  resolveProjectByNameOrId,
  resolveTeamByName,
  summarizeTeamMembers,
} from './projectGraph.resolvers.js';

export const PROJECT_ANALYTICS_METRICS = ['list_with_teams', 'team_lookup', 'assignment_summary'];

/**
 * Natural-language detector for project ↔ team relationship asks.
 */
export function looksLikeProjectTeamQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/\b(list|show|give|tell)\b.{0,50}\b(projects?|them)\b.{0,80}\b(team|teams)\b/i.test(t)) return true;
  if (/\b(projects?|them)\b.{0,50}\b(team|teams)\b.{0,50}\b(assigned|assignment|working)\b/i.test(t)) return true;
  if (/\b(which|what)\s+team\b.{0,60}\b(project|assigned|working|on)\b/i.test(t)) return true;
  if (/\bteam\b.{0,40}\b(assigned|on|for|to|working)\b.{0,40}\bproject\b/i.test(t)) return true;
  if (/\bproject\b.{0,40}\bteam\b.{0,40}\b(assigned|assignment|mapping|map)\b/i.test(t)) return true;
  if (/\b(assigned|unassigned)\b.{0,30}\bprojects?\b/i.test(t)) return true;
  if (/\bprojects?\b.{0,30}\b(assigned|unassigned)\b/i.test(t)) return true;
  return false;
}

/**
 * Follow-up after a project count: "list them", "which team", etc.
 * @param {string} text
 * @param {object|null} memory lastEntities snapshot
 */
export function looksLikeProjectTeamContinuation(text, memory = null) {
  const t = String(text || '');
  const lastTopic = (memory?.lastTopic || '').toLowerCase();
  const wasProject = lastTopic === 'project' || lastTopic === 'projects';
  if (!wasProject) return false;
  if (looksLikeProjectTeamQuery(t)) return true;
  if (/\b(list|show)\b.{0,20}\b(them|all|names?|details?)\b/i.test(t) && memory?.lastProjectCount != null) {
    return true;
  }
  if (/\b(which|what)\s+team\b/i.test(t)) return true;
  return false;
}

/**
 * Reject relational NL fragments mistaken for entity names ("which", "has which project").
 */
function isConcreteEntityName(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return false;
  if (/^(which|what|who|whom|them|all|each|every|this|that|these|those)$/i.test(n)) return false;
  if (/\b(which|what|project|projects|assigned|has|have|is|are|working|on|for|to)\b/i.test(n)) return false;
  return true;
}

/**
 * Infer metric + optional entity names from NL.
 * @returns {{ metric: string, projectName?: string, teamName?: string, phrase: string }}
 */
export function extractProjectAnalyticsArgs(text) {
  const phrase = String(text || '');
  const out = { metric: 'list_with_teams', phrase };

  const projectOn = phrase.match(
    /\b(?:team\s+(?:assigned|working)\s+(?:on|to|for)\s+|which\s+team\s+(?:is\s+)?(?:on|assigned\s+to|working\s+on)\s+)(?:project\s+)?["']?([^"'.?\n]+?)["']?(?:\?|$|\bproject\b)/i,
  );
  if (projectOn && isConcreteEntityName(projectOn[1])) {
    out.projectName = projectOn[1].trim();
    out.metric = 'team_lookup';
    return out;
  }

  const whichTeam = phrase.match(/\bwhich\s+team\b.{0,40}\bproject\s+["']?([^"'.?\n]+)["']?/i);
  if (whichTeam && isConcreteEntityName(whichTeam[1])) {
    out.projectName = whichTeam[1].trim();
    out.metric = 'team_lookup';
    return out;
  }

  if (
    /\b(how many|count|number of)\b.{0,40}\b(assigned|unassigned)\b/i.test(phrase)
    || /\bassignment summary\b/i.test(phrase)
    || /\bhow many assigned\b/i.test(phrase)
  ) {
    out.metric = 'assignment_summary';
    return out;
  }

  if (looksLikeProjectTeamQuery(phrase)) {
    out.metric = 'list_with_teams';
  }

  // Named team filter — explicit "projects for team X" only; never relational fragments.
  if (!out.projectName) {
    const forTeam = phrase.match(
      /\bprojects?\b.{0,40}\b(?:for|of|on)\s+team\s+["']?([^"'.?\n]+?)["']?(?:\?|$|\bwith\b|\band\b|\bassigned\b)/i,
    );
    if (forTeam && isConcreteEntityName(forTeam[1])) {
      out.teamName = forTeam[1].trim();
    } else {
      const namedTeam = phrase.match(/\bteam\s+(?:named|called)\s+["']?([^"'.?\n]+?)["']?(?:\?|$)/i);
      if (namedTeam && isConcreteEntityName(namedTeam[1])) out.teamName = namedTeam[1].trim();
    }
  }

  return out;
}

function assignmentStats(rows) {
  const total = rows.length;
  const assigned = rows.filter((r) => r.hasTeams).length;
  return { total, assigned, unassigned: total - assigned };
}

function resolveAuthoritativeCount(metric, stats, lookup) {
  if (metric === 'team_lookup' && lookup) {
    return {
      count: lookup.teams?.length ?? 0,
      label: lookup.hasTeams ? 'teams_on_project' : 'teams_on_project',
    };
  }
  if (metric === 'assignment_summary') {
    return { count: stats.total, label: 'projects_total' };
  }
  return { count: stats.total, label: 'projects_total' };
}

/**
 * Build authoritative analytics payload for the chatbot.
 */
export function buildProjectAnalyticsPayload({
  metric,
  rows = [],
  stats = {},
  scope = 'all',
  lookup = null,
  searchedFor = null,
  provenance = 'project.service.queryProjects + TeamGroup.assignedTeams',
} = {}) {
  const auth = resolveAuthoritativeCount(metric, stats, lookup);
  return {
    metric,
    authoritative: true,
    authoritativeCount: auth.count,
    authoritativeLabel: auth.label,
    provenance,
    scope,
    stats,
    rows,
    lookup,
    searchedFor,
    formattedTable: buildFormattedProjectTeamSummary(rows, stats),
    partialList: false,
  };
}

/**
 * Deterministic prose/table block for summarizeData — LLM must mirror this.
 */
export function buildFormattedProjectTeamSummary(rows, stats) {
  const { total = rows.length, assigned = 0, unassigned = 0 } = stats;
  const lines = [];

  if (total === 0) {
    lines.push('No projects found in your scope.');
    return lines.join('\n');
  }

  if (assigned === 0) {
    lines.push(`I found ${total} project${total === 1 ? '' : 's'}, but none currently have a team assigned.`);
    lines.push('Project names:');
    for (const r of rows) lines.push(`- ${r.projectName}`);
    return lines.join('\n');
  }

  if (unassigned === 0) {
    lines.push(`${total} project${total === 1 ? '' : 's'} — all have teams assigned.`);
  } else {
    lines.push(`${total} project${total === 1 ? '' : 's'} — ${assigned} assigned, ${unassigned} unassigned`);
  }

  lines.push('| Project | Assigned Team | Team Lead | Members |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    if (!r.hasTeams) {
      lines.push(`| ${r.projectName} | — | — | — |`);
      continue;
    }
    for (const t of r.teams) {
      lines.push(`| ${r.projectName} | ${t.teamName} | ${t.teamLead} | ${t.memberCount} |`);
    }
  }
  return lines.join('\n');
}

/**
 * Execute project_analytics tool.
 * @param {{ user: object, args?: object }} opts
 */
export async function fetchProjectAnalytics({ user, args = {} } = {}) {
  if (!(await hasProjectReadAccess(user))) {
    return {
      forbidden: true,
      reason: 'Missing projects.read / projects.manage permission required to view project analytics.',
    };
  }

  const inferred = extractProjectAnalyticsArgs(args.phrase || '');
  const metric = String(args.metric || inferred.metric || 'list_with_teams').toLowerCase();
  const projectName = args.projectName || args.project || inferred.projectName || null;
  const teamName = args.teamName || args.team || inferred.teamName || null;

  if (metric === 'team_lookup') {
    const query = projectName || args.phrase || '';
    const resolved = await resolveProjectByNameOrId(query, user);
    if (resolved.kind === 'notFound') {
      return buildProjectAnalyticsPayload({
        metric,
        rows: [],
        stats: { total: 0, assigned: 0, unassigned: 0 },
        scope: 'mine',
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
    const [enriched] = await enrichProjectsWithTeams([resolved.project], user);
    const rows = buildProjectTeamTable([enriched]);
    const lookup = {
      projectId: rows[0]?.projectId,
      projectName: rows[0]?.projectName,
      hasTeams: rows[0]?.hasTeams,
      teams: rows[0]?.teams || [],
    };
    const stats = { total: 1, assigned: lookup.hasTeams ? 1 : 0, unassigned: lookup.hasTeams ? 0 : 1 };
    return buildProjectAnalyticsPayload({
      metric,
      rows,
      stats,
      scope: 'all',
      lookup,
      searchedFor: query,
    });
  }

  if (metric === 'assignment_summary' || metric === 'list_with_teams') {
    let projects;
    let total;
    let scope;

    if (teamName && (await hasTeamReadAccess(user))) {
      const teamRes = await resolveTeamByName(teamName, user);
      if (teamRes.kind === 'notFound') {
        return buildProjectAnalyticsPayload({
          metric,
          rows: [],
          stats: { total: 0, assigned: 0, unassigned: 0 },
          searchedFor: teamName,
        });
      }
      if (teamRes.kind === 'ambiguous') {
        return {
          ambiguous: true,
          searchedFor: teamName,
          matches: (teamRes.matches || []).map((t) => ({ id: String(t._id), name: t.name })),
          authoritative: true,
        };
      }
      const pids = await projectIdsForTeam(teamRes.team._id || teamRes.team.id);
      const all = await fetchAccessibleProjects(user, { limit: 200 });
      projects = all.projects.filter((p) => pids.includes(String(p._id || p.id)));
      total = projects.length;
      scope = all.scope;
    } else {
      const all = await fetchAccessibleProjects(user, { limit: 200, status: args.status });
      projects = all.projects;
      total = all.total;
      scope = all.scope;
    }

    const enriched = await enrichProjectsWithTeams(projects, user);
    const rows = buildProjectTeamTable(enriched);
    const stats = assignmentStats(rows);
    stats.total = total;

    return buildProjectAnalyticsPayload({
      metric,
      rows,
      stats,
      scope,
      partialList: rows.length < total,
    });
  }

  return buildProjectAnalyticsPayload({
    metric: 'list_with_teams',
    rows: [],
    stats: { total: 0, assigned: 0, unassigned: 0 },
  });
}

/** Entity hints for conversation memory after a project fetch/analytics turn. */
export function extractProjectMemoryHints(fetched = {}) {
  const out = {};
  const proj = fetched.fetch_projects;
  const analytics = fetched.project_analytics;

  if (proj && typeof proj.total === 'number') {
    out.lastProjectCount = proj.total;
    out.lastTopic = 'projects';
    out.lastScope = proj.scope || null;
    const names = (proj.records || []).map((p) => p.name).filter(Boolean);
    if (names.length) out.lastProjectNames = names.slice(0, 50);
  }

  if (analytics && !analytics.forbidden) {
    out.lastTopic = 'projects';
    out.lastScope = analytics.scope || null;
    if (typeof analytics.authoritativeCount === 'number') {
      out.lastProjectCount = analytics.stats?.total ?? analytics.authoritativeCount;
    }
    const names = (analytics.rows || []).map((r) => r.projectName).filter(Boolean);
    if (names.length) out.lastProjectNames = names.slice(0, 50);
    if (analytics.lookup?.projectName) out.projectName = analytics.lookup.projectName;
    if (analytics.lookup?.teams?.[0]?.teamName) out.lastTeamName = analytics.lookup.teams[0].teamName;
  }

  return out;
}

export { summarizeTeamMembers };
