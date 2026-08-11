/**
 * Atomic task query — single source of truth for count + list in Sage task replies.
 * Count and rows always come from one queryTasks execution with identical filters.
 */

import crypto from 'crypto';
import { queryTasks } from '../task.service.js';
import {
  buildTaskServiceFilter,
  buildAccessibleTaskFilter,
} from './taskAccess.js';
import { resolveProjectByNameOrId } from './projectGraph.resolvers.js';
import { stageLabelForStatus } from './taskStageVocabulary.js';

/** @param {object} row */
export function mapTaskRow(row) {
  const assignees = Array.isArray(row.assignedTo)
    ? row.assignedTo.map((a) => (typeof a === 'object' ? a.name : a)).filter(Boolean)
    : [];
  return {
    taskId: String(row._id || row.id || row.taskId || ''),
    title: row.title,
    taskKey: row.taskKey || row.taskCode || row.key || null,
    status: row.status,
    dueDate: row.dueDate ? new Date(row.dueDate).toISOString().slice(0, 10) : null,
    projectName: typeof row.projectId === 'object' ? row.projectId?.name : (row.projectName || null),
    projectId: row.projectId ? String(row.projectId?._id || row.projectId) : null,
    assigneeLabel: assignees.length ? assignees.join(', ') : 'Unassigned',
    tags: row.tags || [],
    sprintName: typeof row.sprintId === 'object' ? row.sprintId?.name : (row.sprintName || null),
  };
}

/**
 * Apply Task Board uiContext filters so backend query matches visible board rows.
 * @param {object} filters — mutated in place
 * @param {object|null} uiContext
 */
export function applyUiContextToTaskFilters(filters, uiContext) {
  if (!uiContext || uiContext.currentModule !== 'TaskBoard') return;
  const af = uiContext.activeFilters || {};
  if (af.search && !filters.search) filters.search = af.search;
  if (af.assignee === 'me' && !filters.assignedToMe) filters.assignedToMe = true;
  if (af.assignee === 'unassigned' && !filters.unassigned) filters.unassigned = true;
  if (!filters.status && af.stage) filters.status = af.stage;
}

/**
 * @param {object|null} uiContext
 * @param {object} user
 * @returns {Promise<string|null>} projectId
 */
export async function resolveProjectIdFromUiContext(uiContext, user) {
  const label = uiContext?.currentProject;
  if (!label || /^all projects$/i.test(String(label).trim())) return null;
  const resolved = await resolveProjectByNameOrId(label, user);
  if (resolved.kind === 'found') return String(resolved.project._id || resolved.project.id);
  return null;
}

/** @param {object} filters */
export function hashTaskFilters(filters) {
  const stable = JSON.stringify(filters, Object.keys(filters).sort());
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * @param {{ filters: object, total: number, records: object[], scope?: string, queryId?: string }} input
 */
export function buildTaskResultEnvelope({ filters = {}, total, records = [], scope = 'mine', queryId = null }) {
  const id = queryId || hashTaskFilters(filters);
  const tasks = records.map(mapTaskRow);
  return {
    type: 'task_result',
    query: {
      entity: 'task',
      filters: { ...filters },
      queryId: id,
    },
    result: {
      total,
      tasks,
    },
    // Backward-compat fields consumed by summarizeData / memory / legacy paths
    records,
    rows: tasks,
    total,
    scope,
    queryId: id,
    filters: { ...filters },
    label: 'task',
    provenance: 'task.service.queryTasks',
    authoritative: true,
    authoritativeCount: total,
  };
}

/**
 * @param {object} payload — task_result envelope or legacy fetch_tasks / task_board shape
 * @param {number|null} [proseCount]
 */
export function assertTaskResultIntegrity(payload, proseCount = null) {
  if (!payload) return { ok: true, issues: [] };
  const issues = [];
  const total = Number(
    payload?.result?.total
    ?? payload?.authoritativeCount
    ?? payload?.total
    ?? NaN,
  );
  const tasks = payload?.result?.tasks
    ?? payload?.rows
    ?? payload?.records?.map((r) => (r.taskId ? r : mapTaskRow(r)))
    ?? [];

  if (!Number.isFinite(total)) {
    issues.push('task_result missing authoritative total');
  } else if (tasks.length > total) {
    issues.push(`task_result rows (${tasks.length}) exceed total (${total})`);
  }

  const status = payload?.query?.filters?.status ?? payload?.filters?.status ?? null;
  if (status) {
    for (const t of tasks) {
      if (t.status && t.status !== status) {
        issues.push(`task "${t.title || t.taskId}" status=${t.status} != filter ${status}`);
        break;
      }
    }
  }

  if (proseCount != null && Number.isFinite(total) && proseCount !== total) {
    issues.push(`prose count (${proseCount}) != result.total (${total})`);
  }

  if (issues.length) {
    const err = new Error(`task_result integrity: ${issues.join('; ')}`);
    err.issues = issues;
    throw err;
  }
  return { ok: true, issues: [] };
}

/**
 * Single atomic task query — count and list from identical filters.
 * @param {object} user
 * @param {{ filters?: object, limit?: number, sortBy?: string, uiContext?: object|null }} [options]
 */
export async function executeAtomicTaskQuery(user, options = {}) {
  const {
    filters: inputFilters = {},
    limit = 50,
    sortBy = '-dueDate',
    uiContext = null,
  } = options;

  const filters = { ...inputFilters };
  applyUiContextToTaskFilters(filters, uiContext);

  if (!filters.projectId && uiContext?.currentModule === 'TaskBoard') {
    const pid = await resolveProjectIdFromUiContext(uiContext, user);
    if (pid) filters.projectId = pid;
  }

  const serviceFilter = buildTaskServiceFilter(user, filters);
  const { scope } = await buildAccessibleTaskFilter(user, {});
  const result = await queryTasks(serviceFilter, { limit, sortBy });
  const records = result.results || [];
  const total = result.totalResults ?? records.length;

  const envelope = buildTaskResultEnvelope({ filters, total, records, scope });
  assertTaskResultIntegrity(envelope);
  return envelope;
}

/**
 * Resolve the canonical task payload from a fetched blob for renderers.
 * @param {object|null} fetched
 */
export function resolveTaskPayload(fetched) {
  if (!fetched) return null;
  if (fetched.task_result) return fetched.task_result;
  if (fetched.task_board_analytics?.type === 'task_result') return fetched.task_board_analytics;
  if (fetched.task_board_analytics?.result) {
    return {
      ...fetched.task_board_analytics,
      type: 'task_result',
      result: {
        total: fetched.task_board_analytics.authoritativeCount ?? fetched.task_board_analytics.total ?? 0,
        tasks: fetched.task_board_analytics.rows || [],
      },
      query: {
        entity: 'task',
        filters: fetched.task_board_analytics.lookup
          ? { status: fetched.task_board_analytics.lookup.stage }
          : {},
        queryId: fetched.task_board_analytics.queryId || null,
      },
    };
  }
  if (fetched.fetch_tasks?.type === 'task_result') return fetched.fetch_tasks;
  if (fetched.fetch_tasks) {
    const data = fetched.fetch_tasks;
    return buildTaskResultEnvelope({
      filters: data.filters || {},
      total: data.total ?? data.records?.length ?? 0,
      records: data.records || [],
      scope: data.scope,
      queryId: data.queryId,
    });
  }
  return null;
}

export function stageLabelFromFilters(filters = {}) {
  if (filters.status) return stageLabelForStatus(filters.status);
  return null;
}
