/**
 * Conversation Context Manager / Reference Resolver.
 * Runs BEFORE LLM/tool routing to rewrite pronoun follow-ups ("list them")
 * into explicit entity queries using conversation memory.
 */

/** Pronoun / deictic follow-up patterns with no topic of their own. */
export const RESOLVED_FOLLOWUP_RE =
  /^\s*(list|show)(\s+(me|all|of))?\s+(them|those|these)\.?\s*$|^\s*show\s+(all\s+)?of\s+them\.?\s*$|^\s*(list|show)\s+(all\s+)?(of\s+)?(them|those|these)\.?\s*$|^\s*show\s+me\s+their\s+names?\.?\s*$|^\s*(what are|give me)\s+their\s+names?\.?\s*$/i;

const ORDINAL_RE =
  /^\s*(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(one|item|department|project|team|task|employee|manager|supervisor)\.?\s*$/i;

const POSSESSIVE_TASKS_RE = /^\s*(?:his|her|their)\s+tasks\.?\s*$/i;

/** Maps memory entity type → list rewrite + tool routing. */
const ENTITY_ROUTE = {
  department: {
    listPhrase: 'list all departments',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'departments' },
  },
  departments: {
    listPhrase: 'list all departments',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'departments' },
  },
  manager: {
    listPhrase: 'list all managers',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'managers' },
  },
  managers: {
    listPhrase: 'list all managers',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'managers' },
  },
  supervisor: {
    listPhrase: 'list all supervisors',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'supervisors' },
  },
  supervisors: {
    listPhrase: 'list all supervisors',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'supervisors' },
  },
  project: {
    listPhrase: 'list all projects',
    toolName: 'fetch_projects',
    toolArgs: {},
  },
  projects: {
    listPhrase: 'list all projects with teams',
    toolName: 'project_analytics',
    toolArgs: { metric: 'list_with_teams' },
  },
  task: {
    listPhrase: 'list all tasks',
    toolName: 'fetch_tasks',
    toolArgs: {},
  },
  tasks: {
    listPhrase: 'list all tasks',
    toolName: 'fetch_tasks',
    toolArgs: {},
  },
  team: {
    listPhrase: 'list all teams',
    toolName: 'team_analytics',
    toolArgs: { metric: 'list' },
  },
  teams: {
    listPhrase: 'list all teams',
    toolName: 'team_analytics',
    toolArgs: { metric: 'list' },
  },
  employee: {
    listPhrase: 'list all employees',
    toolName: 'fetch_employees',
    toolArgs: {},
  },
  employees: {
    listPhrase: 'list all employees',
    toolName: 'fetch_employees',
    toolArgs: {},
  },
  unassigned: {
    listPhrase: 'list unassigned employees',
    toolName: 'org_structure_analytics',
    toolArgs: { metric: 'unassigned' },
  },
};

const METRIC_TO_ENTITY = {
  departments: 'departments',
  managers: 'managers',
  supervisors: 'supervisors',
  unassigned: 'unassigned',
  coverage: 'org_structure',
};

const TOPIC_TO_ENTITY = {
  department: 'departments',
  departments: 'departments',
  manager: 'managers',
  managers: 'managers',
  supervisor: 'supervisors',
  supervisors: 'supervisors',
  project: 'projects',
  projects: 'projects',
  task: 'tasks',
  tasks: 'tasks',
  team: 'teams',
  teams: 'teams',
  employee: 'employees',
  employees: 'employees',
  unassigned: 'unassigned',
  org_structure: 'departments',
};

/**
 * Infer entity type from memory when lastEntityType is absent (legacy docs).
 * @param {object|null} memory
 * @returns {string|null}
 */
export function inferEntityTypeFromMemory(memory = null) {
  if (!memory) return null;
  if (memory.lastEntityType) return String(memory.lastEntityType).toLowerCase();

  const metric = String(memory.lastMetric || '').toLowerCase();
  if (metric && METRIC_TO_ENTITY[metric]) return METRIC_TO_ENTITY[metric];

  const topic = String(memory.lastTopic || '').toLowerCase();
  if (topic && TOPIC_TO_ENTITY[topic]) return TOPIC_TO_ENTITY[topic];

  if (memory.lastProjectCount != null) return 'projects';
  if (memory.lastTeamCount != null || memory.lastTeamName) return 'teams';
  if (memory.lastTaskCount != null || memory.lastTaskFilter) return 'tasks';
  if (memory.lastOrgCount != null && (topic === 'departments' || metric === 'departments')) {
    return 'departments';
  }

  return null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeReferenceFollowUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (RESOLVED_FOLLOWUP_RE.test(t)) return true;
  if (ORDINAL_RE.test(t)) return true;
  if (POSSESSIVE_TASKS_RE.test(t)) return true;
  return false;
}

/**
 * Resolve pronoun / ordinal references using conversation memory.
 *
 * @param {string} text - raw user message
 * @param {object|null} memory - lastEntities snapshot
 * @param {{ entityQueryEnabled?: boolean }} [opts]
 * @returns {{
 *   resolvedText: string,
 *   entityType: string|null,
 *   intent: string|null,
 *   confidence: number,
 *   wasResolved: boolean,
 *   toolName: string|null,
 *   toolArgs: object|null,
 *   useEntityQuery?: boolean,
 * }}
 */
export function resolveReferences(text, memory = null, { entityQueryEnabled = false } = {}) {
  const original = String(text || '').trim();
  const base = {
    resolvedText: original,
    entityType: null,
    intent: null,
    confidence: 0,
    wasResolved: false,
    toolName: null,
    toolArgs: null,
  };

  if (!original) return base;

  const entityType = inferEntityTypeFromMemory(memory);
  if (!entityType) return base;

  const route = ENTITY_ROUTE[entityType];
  if (!route) return base;

  // Employee entityQuery follow-up — replay lastContext filters; do not fetch unfiltered list.
  if (
    entityQueryEnabled &&
    entityType === 'employees' &&
    memory?.lastContext?.entity === 'employees' &&
    RESOLVED_FOLLOWUP_RE.test(original)
  ) {
    return {
      resolvedText: original,
      entityType: 'employees',
      intent: 'list',
      confidence: 0.95,
      wasResolved: true,
      toolName: null,
      toolArgs: null,
      useEntityQuery: true,
    };
  }

  // Pronoun list follow-ups: "list them", "show those", etc.
  if (RESOLVED_FOLLOWUP_RE.test(original)) {
    const toolArgs = { ...route.toolArgs, phrase: route.listPhrase };
    if (entityType === 'employees' && memory?.role) {
      toolArgs.role = memory.role;
    }
    if (entityType === 'tasks' && memory?.lastTaskFilter) {
      toolArgs.status = memory.lastTaskFilter;
    }
    if (entityType === 'teams' && memory?.lastTeamName) {
      toolArgs.teamName = memory.lastTeamName;
    }
    if (entityType === 'projects' && memory?.projectName) {
      toolArgs.projectName = memory.projectName;
    }

    return {
      resolvedText: route.listPhrase,
      entityType,
      intent: 'list',
      confidence: 0.95,
      wasResolved: true,
      toolName: route.toolName,
      toolArgs,
    };
  }

  // Ordinal: "the second one" → item from lastResultList
  const ordMatch = original.match(ORDINAL_RE);
  if (ordMatch && Array.isArray(memory?.lastResultList) && memory.lastResultList.length) {
    const ordMap = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3, '5th': 4 };
    const idx = ordMap[String(ordMatch[1]).toLowerCase()];
    const item = idx != null ? memory.lastResultList[idx] : null;
    if (item?.name) {
      const resolvedText = `tell me about ${item.name}`;
      return {
        resolvedText,
        entityType,
        intent: 'detail',
        confidence: 0.9,
        wasResolved: true,
        toolName: route.toolName,
        toolArgs: { ...route.toolArgs, unitName: item.name, phrase: resolvedText },
      };
    }
  }

  // "his tasks" → last mentioned employee's tasks
  if (POSSESSIVE_TASKS_RE.test(original) && memory?.person) {
    const resolvedText = `list tasks for ${memory.person}`;
    return {
      resolvedText,
      entityType: 'tasks',
      intent: 'list',
      confidence: 0.85,
      wasResolved: true,
      toolName: 'fetch_tasks',
      toolArgs: { assignee: memory.person, phrase: resolvedText },
    };
  }

  return base;
}

/**
 * Build tool routing from a resolved reference (for continuation pre-router).
 * @param {object} resolution - output of resolveReferences
 * @returns {{ toolName: string, toolArgs: object }|null}
 */
export function routeResolvedFollowUp(resolution) {
  if (!resolution?.wasResolved || !resolution.toolName) return null;
  if (resolution.useEntityQuery) return null;
  if (resolution.confidence < 0.8) return null;
  return {
    toolName: resolution.toolName,
    toolArgs: { ...(resolution.toolArgs || {}), phrase: resolution.resolvedText },
  };
}
