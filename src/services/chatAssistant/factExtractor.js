// uat.dharwin.backend/src/services/chatAssistant/factExtractor.js
//
// Strip authoritative numeric facts from a `fetched` blob produced by
// chatAssistant.service.js#executeFetches. Returns the same data the
// summariser already serialises into the prompt — but in a structured
// shape factRenderer + responseValidator can compare against the LLM
// reply.
//
// Returned shape:
//   {
//     counts: [
//       { kind, label, total, role?, date?, status?, breakdown? },
//       ...
//     ],
//     primary: { ...one of the counts above } | null
//   }

import { stageLabelForStatus } from './taskStageVocabulary.js';

function readPeople(fetched) {
  const data = fetched?.fetch_people;
  if (!data || data.notFound) return null;
  const total = Number(data?.page?.total ?? data?.records?.length ?? 0);
  return { kind: 'fetch_people', label: 'people', total };
}

function readJobs(fetched) {
  const data = fetched?.job_result ?? fetched?.fetch_jobs;
  if (!data) return null;
  const total = Number(
    data.result?.total
    ?? data.authoritativeCount
    ?? data.counts?.total
    ?? data.total
    ?? data.records?.length
    ?? 0,
  );
  const filters = data.query?.filters ?? data.filters ?? null;
  const queryId = data.query?.queryId ?? data.queryId ?? null;
  const originLabel = filters?.jobOrigin === 'external'
    ? 'external jobs'
    : filters?.jobOrigin === 'internal'
      ? 'internal jobs'
      : 'jobs';
  return {
    kind: 'fetch_jobs',
    label: originLabel,
    total,
    filters,
    queryId,
    provenance: data.provenance || 'Job.countDocuments+find',
    authoritative: data.authoritative !== false,
  };
}

function readProjects(fetched) {
  const data = fetched?.fetch_projects;
  if (!data || data.forbidden) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return {
    kind: 'fetch_projects',
    label: 'projects',
    total,
    scope: data.scope || null,
    provenance: data.provenance || 'project.service.queryProjects',
    authoritative: data.authoritative !== false,
  };
}

function readTasks(fetched) {
  const data = fetched?.task_result ?? fetched?.fetch_tasks;
  if (!data || data.forbidden) return null;
  const total = Number(data.result?.total ?? data.total ?? data.records?.length ?? 0);
  const tasks = data.result?.tasks ?? data.rows ?? [];
  return {
    kind: 'fetch_tasks',
    label: 'tasks',
    total,
    rows: tasks.slice(0, total),
    scope: data.scope || null,
    filters: data.query?.filters ?? data.filters ?? null,
    queryId: data.query?.queryId ?? data.queryId ?? null,
    provenance: data.provenance || 'task.service.queryTasks',
    authoritative: data.authoritative !== false,
  };
}

function readTaskBoardAnalytics(fetched) {
  const data = fetched?.task_result ?? fetched?.task_board_analytics;
  if (!data || data.forbidden) return null;
  let metric = data.metric || 'stage_counts';
  if (!data.metric && (data.query?.filters?.status || data.lookup?.stage)) {
    metric = 'stage_count';
  }
  const total = Number(data.result?.total ?? data.authoritativeCount ?? 0);
  const tasks = data.result?.tasks ?? data.rows ?? [];
  const filters = data.query?.filters ?? (data.lookup?.stage ? { status: data.lookup.stage } : null);
  if (metric === 'stage_count') {
    const stage = data.lookup?.stage || filters?.status || null;
    const stageLabel = data.lookup?.stageLabel || stageLabelForStatus(stage) || stage || 'stage';
    return {
      kind: 'task_board_stage_count',
      label: `${stageLabel} tasks`,
      total,
      stage,
      stageLabel,
      rows: tasks.slice(0, total),
      filters,
      queryId: data.query?.queryId ?? data.queryId ?? null,
      scope: data.scope || null,
      provenance: data.provenance || 'task_board_analytics',
      authoritative: true,
    };
  }
  if (metric === 'stage_counts') {
    return {
      kind: 'task_board_stage_counts',
      label: 'task board stages',
      total: Number(data.authoritativeCount ?? 0),
      breakdown: data.breakdown?.byStage || null,
      scope: data.scope || null,
      provenance: data.provenance || 'Task.aggregate',
      authoritative: true,
    };
  }
  return {
    kind: 'task_board_analytics',
    label: metric.replace(/_/g, ' '),
    total: Number(data.authoritativeCount ?? 0),
    metric,
    scope: data.scope || null,
    provenance: data.provenance || 'task_board_analytics',
    authoritative: true,
  };
}

function readProjectAnalytics(fetched) {
  const data = fetched?.project_analytics;
  if (!data || data.forbidden) return null;
  const total = Number(data.stats?.total ?? data.authoritativeCount ?? 0);
  return {
    kind: 'project_analytics',
    label: 'projects',
    total,
    scope: data.scope || null,
    provenance: data.provenance || 'project.service.queryProjects + TeamGroup.assignedTeams',
    authoritative: true,
  };
}

/**
 * @param {object} fetched - output of executeFetches
 * @param {string} [lastUserMsg] - last user message, used to bias the
 *   "primary" pick toward whatever the user actually asked for.
 */
export function extractFacts(fetched, lastUserMsg = '') {
  const counts = [];
  const push = (f) => { if (f) counts.push(f); };
  push(readPeople(fetched));
  push(readJobs(fetched));
  push(readProjects(fetched));
  push(readTasks(fetched));
  push(readTaskBoardAnalytics(fetched));
  push(readProjectAnalytics(fetched));

  let primary = null;
  if (lastUserMsg && counts.length) {
    const txt = lastUserMsg.toLowerCase();
    primary =
      counts.find((c) => c.kind === 'task_board_stage_count') ||
      counts.find((c) => c.role && txt.includes(String(c.role).toLowerCase())) ||
      counts.find((c) => c.label && txt.includes(c.label.toLowerCase())) ||
      counts.find((c) => c.kind !== 'fetch_tasks') ||
      counts[0];
  } else {
    primary = counts[0] || null;
  }

  return { counts, primary };
}
