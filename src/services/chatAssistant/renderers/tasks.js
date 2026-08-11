// Render atomic task_result payloads as TableBlock — rows always match authoritative total.

import { stageLabelFromFilters } from '../taskResult.js';

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'completed') return 'neutral';
  if (v === 'on_going' || v === 'in_review') return 'info';
  if (v === 'todo' || v === 'new') return 'warn';
  return 'neutral';
};

const TASK_COLUMNS = [
  { key: 'title', label: 'Task', priority: 'primary' },
  { key: 'taskKey', label: 'Key', priority: 'secondary', format: 'mono' },
  { key: 'status', label: 'Status', priority: 'primary', format: 'badge' },
  { key: 'projectName', label: 'Project', priority: 'secondary' },
  { key: 'assigneeLabel', label: 'Assignee', priority: 'secondary' },
  { key: 'dueDate', label: 'Due', priority: 'secondary', format: 'date' },
];

/**
 * @param {object|null} payload — task_result envelope
 * @param {{ listIntent?: boolean, queryArg?: string }} ctx
 * @param {object} [fact]
 */
export function renderTasks(payload, ctx = {}, fact = null) {
  if (!payload) return null;

  const total = Number(
    payload?.result?.total
    ?? payload?.authoritativeCount
    ?? payload?.total
    ?? 0,
  );
  const tasks = payload?.result?.tasks ?? payload?.rows ?? [];
  const filters = payload?.query?.filters ?? payload?.filters ?? {};
  const queryId = payload?.query?.queryId ?? payload?.queryId ?? null;

  if (!tasks.length) {
    if (ctx?.listIntent) return null;
    if (typeof total !== 'number') return null;
    return null;
  }

  const stageLabel = stageLabelFromFilters(filters);
  const title = stageLabel
    ? `${stageLabel} tasks (${total})`
    : `Tasks (${total})`;

  const rows = tasks.slice(0, Math.min(tasks.length, total)).map((t) => ({
    title: cell(t.title),
    taskKey: cell(t.taskKey),
    status: { v: cell(t.status), tone: statusTone(t.status) },
    projectName: cell(t.projectName),
    assigneeLabel: cell(t.assigneeLabel),
    dueDate: cell(t.dueDate),
  }));

  const columns = TASK_COLUMNS.filter((col) =>
    rows.some((row) => {
      const v = row[col.key];
      const text = v && typeof v === 'object' ? v.v : v;
      return text && text !== '—' && text !== '';
    }),
  );

  if (!columns.length) return null;

  const block = {
    type: 'table',
    id: 'tasks',
    tableType: 'tasks',
    title,
    columns,
    rows,
    layout: 'auto',
    queryId,
    pagination: { total },
  };

  const markdown = stageLabel
    ? `Showing ${rows.length} of ${total} **${stageLabel}** task(s) — table below.`
    : `Showing ${rows.length} of ${total} task(s) — table below.`;

  return { block, markdown };
}
