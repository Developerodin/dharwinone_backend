import mongoose from 'mongoose';
import Project from '../../models/project.model.js';
import TeamMember from '../../models/team.model.js';
import {
  fetchAccessibleTeams,
  hasTeamReadAccess,
  resolveTeamByName,
  summarizeTeamMembers,
} from './projectGraph.resolvers.js';

export const TEAM_ANALYTICS_METRICS = ['list', 'count', 'members', 'idle_teams'];

const ACTIVE_PROJECT_STATUSES = ['Inprogress', 'On hold'];

/**
 * Detect PM workforce team (TeamGroup) asks — not org-chart departments.
 */
export function looksLikeTeamQuery(text) {
  const t = String(text || '');
  if (!t.trim()) return false;

  if (looksLikeOrgTeamDisambiguation(t)) return false;

  if (/\b(how many|count|number of|total)\b.{0,40}\bteams?\b/i.test(t)) return true;
  if (/\b(list|show|give|tell)\b.{0,50}\b(teams?|team groups?|workforce teams?)\b/i.test(t)) return true;
  if (/\bwho (is|are) (in|on)\b.{0,40}\bteam\b/i.test(t)) return true;
  if (/\bteam\b.{0,40}\b(members?|roster|people)\b/i.test(t)) return true;
  if (/\b(idle|inactive|unassigned)\b.{0,40}\bteams?\b/i.test(t)) return true;
  if (/\bteams?\b.{0,40}\b(no|without|missing)\b.{0,20}\b(active )?projects?\b/i.test(t)) return true;
  return false;
}

/** Exclude org-chart / HR department asks from PM TeamGroup routing. */
export function looksLikeOrgTeamDisambiguation(text) {
  const t = String(text || '');
  if (/\b(org(anisation|anization)?\s*(chart|structure)|department(s)?\s+(without|missing)|unassigned employees?)\b/i.test(t)) {
    return true;
  }
  if (/\b(people|employees?|staff|members?)\b.{0,40}\b(in|under|of)\b.{0,40}\b(department|org)\b/i.test(t)) {
    return true;
  }
  if (/\bteam\b.{0,40}\b(in|of|under)\b.{0,40}\b(department|org|chart|structure)\b/i.test(t)) {
    return true;
  }
  return false;
}

export function looksLikeTeamContinuation(text, memory = null) {
  const t = String(text || '');
  const lastTopic = (memory?.lastTopic || '').toLowerCase();
  if (lastTopic !== 'teams' && lastTopic !== 'team') return false;
  if (/\b(list|show|names?|details?|members?|who)\b/i.test(t)) return true;
  if (/\bwhich team\b/i.test(t)) return true;
  return false;
}

/**
 * @returns {{ metric: string, teamName?: string, phrase: string }}
 */
export function extractTeamAnalyticsArgs(text) {
  const phrase = String(text || '');
  const out = { metric: 'count', phrase };

  if (/\b(idle|inactive)\b.{0,30}\bteams?\b/i.test(phrase)
    || /\bteams?\b.{0,40}\b(no|without|missing)\b.{0,20}\b(active )?projects?\b/i.test(phrase)) {
    out.metric = 'idle_teams';
    return out;
  }

  if (/\bwho (is|are) (in|on)\b/i.test(phrase)
    || /\bteam\b.{0,40}\b(members?|roster|people)\b/i.test(phrase)) {
    out.metric = 'members';
  } else if (/\b(list|show|give|tell|names?)\b/i.test(phrase)) {
    out.metric = 'list';
  } else if (/\b(how many|count|number of|total)\b/i.test(phrase)) {
    out.metric = 'count';
  }

  const teamNamed = phrase.match(/\bteam\s+["']?([^"'.?\n]+?)["']?(?:\?|$|\b(members?|roster|people)\b)/i)
    || phrase.match(/\b(?:in|on)\s+team\s+["']?([^"'.?\n]+)["']?/i);
  if (teamNamed) out.teamName = teamNamed[1].trim();

  return out;
}

async function loadTeamMemberCounts(teamIds) {
  const unique = [...new Set(teamIds.map(String).filter(Boolean))];
  const validIds = unique.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!validIds.length) return new Map();

  const counts = await TeamMember.aggregate([
    { $match: { teamId: { $in: validIds.map((id) => new mongoose.Types.ObjectId(id)) }, isActive: { $ne: false } } },
    { $group: { _id: '$teamId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((c) => [String(c._id), c.count]));
}

async function teamIdsWithActiveProjects(teamIds) {
  const activeProjects = await Project.find({
    assignedTeams: { $in: teamIds },
    status: { $in: ACTIVE_PROJECT_STATUSES },
  })
    .select('assignedTeams')
    .lean();

  const busy = new Set();
  for (const p of activeProjects) {
    for (const tid of p.assignedTeams || []) {
      busy.add(String(tid));
    }
  }
  return busy;
}

export function buildTeamTableRows(teams, memberCounts = new Map()) {
  return (teams || []).map((t) => {
    const id = String(t._id || t.id);
    const lead = t.teamLead;
    return {
      teamId: id,
      teamName: t.name,
      department: t.department || null,
      leadName: (lead && typeof lead === 'object' ? lead.fullName : null) || null,
      memberCount: memberCounts.get(id) ?? 0,
      description: t.description || null,
    };
  });
}

export function buildFormattedTeamSummary(rows, stats, metric) {
  const { total = rows.length, idle = 0 } = stats;
  const lines = [];

  if (total === 0) {
    lines.push('No workforce teams (TeamGroup) found in your scope.');
    return lines.join('\n');
  }

  if (metric === 'count') {
    lines.push(`There ${total === 1 ? 'is' : 'are'} **${total}** workforce team${total === 1 ? '' : 's'} in the system.`);
    return lines.join('\n');
  }

  if (metric === 'idle_teams') {
    lines.push(`${idle} team${idle === 1 ? '' : 's'} with no active projects (${total} total accessible teams).`);
    if (!rows.length) {
      lines.push('All accessible teams currently have at least one active project.');
    }
  } else {
    lines.push(`${total} workforce team${total === 1 ? '' : 's'}:`);
  }

  if (rows.length) {
    lines.push('| Team | Lead | Members | Department |');
    lines.push('|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.teamName} | ${r.leadName || '—'} | ${r.memberCount ?? 0} | ${r.department || '—'} |`);
    }
  }

  return lines.join('\n');
}

export function buildTeamAnalyticsPayload({
  metric,
  rows = [],
  stats = {},
  scope = 'all',
  lookup = null,
  searchedFor = null,
  provenance = 'teamGroup.service.queryTeamGroups',
} = {}) {
  const count = metric === 'idle_teams' ? (stats.idle ?? rows.length) : (stats.total ?? rows.length);
  return {
    metric,
    authoritative: true,
    authoritativeCount: count,
    authoritativeLabel: metric === 'members' ? 'team_members' : 'teams_total',
    provenance,
    scope,
    stats,
    rows,
    lookup,
    searchedFor,
    formattedSummary: buildFormattedTeamSummary(rows, stats, metric),
    partialList: false,
  };
}

/**
 * Execute team_analytics tool — PM TeamGroup counts/lists (NOT org departments).
 */
export async function fetchTeamAnalytics({ user, args = {} } = {}) {
  if (!(await hasTeamReadAccess(user))) {
    return {
      forbidden: true,
      reason: 'Missing teams.read / teams.manage permission required to view workforce teams (TeamGroup).',
    };
  }

  const inferred = extractTeamAnalyticsArgs(args.phrase || '');
  const metric = String(args.metric || inferred.metric || 'count').toLowerCase();
  const teamName = args.teamName || args.team || inferred.teamName || null;

  if (metric === 'members') {
    const query = teamName || args.phrase || '';
    if (!query.trim()) {
      return buildTeamAnalyticsPayload({
        metric,
        rows: [],
        stats: { total: 0 },
        lookup: { error: 'team_name_required' },
      });
    }
    const resolved = await resolveTeamByName(query, user);
    if (resolved.kind === 'notFound') {
      return buildTeamAnalyticsPayload({
        metric,
        rows: [],
        stats: { total: 0 },
        searchedFor: query,
        lookup: { notFound: true, teamName: query },
      });
    }
    if (resolved.kind === 'ambiguous') {
      return {
        ambiguous: true,
        searchedFor: query,
        matches: (resolved.matches || []).map((t) => ({ id: String(t._id), name: t.name })),
        authoritative: true,
      };
    }
    const members = summarizeTeamMembers(resolved.members || []);
    const lookup = {
      teamId: String(resolved.team._id || resolved.team.id),
      teamName: resolved.team.name,
      memberCount: members.length,
      members,
    };
    return buildTeamAnalyticsPayload({
      metric,
      rows: members.map((m) => ({ name: m.name, email: m.email, isOrphan: m.isOrphan })),
      stats: { total: members.length },
      scope: 'all',
      lookup,
      searchedFor: query,
    });
  }

  const { teams, total, scope } = await fetchAccessibleTeams(user, { limit: 200 });
  const teamIds = teams.map((t) => t._id || t.id).filter(Boolean);
  const memberCounts = await loadTeamMemberCounts(teamIds);
  let rows = buildTeamTableRows(teams, memberCounts);

  if (metric === 'idle_teams') {
    const busy = await teamIdsWithActiveProjects(teamIds);
    rows = rows.filter((r) => !busy.has(r.teamId));
    return buildTeamAnalyticsPayload({
      metric,
      rows,
      stats: { total, idle: rows.length },
      scope,
    });
  }

  return buildTeamAnalyticsPayload({
    metric,
    rows,
    stats: { total },
    scope,
    partialList: rows.length < total,
  });
}

/** Entity hints for conversation memory after a team fetch/analytics turn. */
export function extractTeamMemoryHints(fetched = {}) {
  const out = {};
  const analytics = fetched.team_analytics;

  if (analytics && !analytics.forbidden) {
    out.lastTopic = 'teams';
    out.lastScope = analytics.scope || null;
    if (typeof analytics.authoritativeCount === 'number') {
      out.lastTeamCount = analytics.authoritativeCount;
    }
    const names = (analytics.rows || []).map((r) => r.teamName).filter(Boolean);
    if (names.length) out.lastTeamNames = names.slice(0, 50);
    if (analytics.lookup?.teamName) out.lastTeamName = analytics.lookup.teamName;
    if (analytics.lookup?.teamId) out.teamId = analytics.lookup.teamId;
  }

  return out;
}
