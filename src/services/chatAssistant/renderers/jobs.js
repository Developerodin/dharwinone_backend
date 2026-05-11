// uat.dharwin.backend/src/services/chatAssistant/renderers/jobs.js
//
// Render `fetch_jobs` retrieval as a TableBlock when records are present.
// Frontend `TableBlockView` paginates at >TABLE_PAGE_SIZE (10) rows, so
// emitting structured rows here is what makes "list all jobs" paginate.
// Falls back to genericCount when no records (e.g. only counts known).

import { renderGenericCount } from './genericCount.js';

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'active' || v === 'open')   return 'success';
  if (v === 'closed' || v === 'filled') return 'neutral';
  if (v === 'draft' || v === 'pending') return 'warn';
  if (v === 'archived' || v === 'expired') return 'danger';
  return 'info';
};

const originTone = (o) => {
  if (/external/i.test(String(o || ''))) return 'info';
  return 'neutral';
};

const formatSalary = (r) => {
  const sr = r.salaryRange;
  if (!sr || typeof sr !== 'object') return '';
  const min = sr.min ?? sr.from ?? null;
  const max = sr.max ?? sr.to ?? null;
  const cur = sr.currency || '';
  if (min == null && max == null) return '';
  if (min != null && max != null) return `${cur}${min}–${max}`.trim();
  return `${cur}${min ?? max}`.trim();
};

const formatOrg = (r) => {
  const o = r.organisation;
  if (!o) return '';
  if (typeof o === 'string') return o;
  return o.name || '';
};

const JOB_COLUMNS = [
  { key: 'title',           label: 'Title',      priority: 'primary' },
  { key: 'organisation',    label: 'Company',    priority: 'secondary' },
  { key: 'jobType',         label: 'Type',       priority: 'secondary' },
  { key: 'location',        label: 'Location',   priority: 'secondary' },
  { key: 'experienceLevel', label: 'Experience', priority: 'secondary' },
  { key: 'salary',          label: 'Salary',     priority: 'secondary' },
  { key: 'origin',          label: 'Origin',     priority: 'secondary' },
  { key: 'status',          label: 'Status',     priority: 'primary', format: 'badge' },
];

/**
 * @param {{ records?: object[], counts?: { internal:number, external:number, total:number }, label?: string }} data
 * @param {{ listIntent?: boolean, queryArg?: string }} ctx
 * @param {object} fact
 * @returns {{ block:object, markdown:string }|null}
 */
export function renderJobs(data, ctx = {}, fact) {
  const records = Array.isArray(data?.records) ? data.records : [];
  const totalKnown = Number(data?.counts?.total ?? records.length ?? 0);

  if (!records.length) {
    if (ctx?.listIntent) return null;
    return fact ? renderGenericCount(fact, ctx) : null;
  }

  const rows = records.map((r) => ({
    title:           cell(r.title),
    organisation:    cell(formatOrg(r)),
    jobType:         cell(r.jobType),
    location:        cell(r.location),
    experienceLevel: cell(r.experienceLevel),
    salary:          cell(formatSalary(r)),
    origin:          { v: cell(r._origin || (r.jobOrigin === 'external' ? 'External' : 'Internal')), tone: originTone(r.jobOrigin) },
    status:          { v: cell(r.status || 'Active'), tone: statusTone(r.status) },
  }));

  const columns = JOB_COLUMNS.filter((col) => {
    return rows.some((row) => {
      const v = row[col.key];
      const text = v && typeof v === 'object' ? v.v : v;
      return text && text !== '—' && text !== '';
    });
  });

  if (!columns.length) {
    if (ctx?.listIntent) return null;
    return fact ? renderGenericCount(fact, ctx) : null;
  }

  const title = `Jobs (${totalKnown})`;
  const block = {
    type: 'table',
    id: 'jobs',
    tableType: 'jobs',
    title,
    columns,
    rows,
    layout: 'auto',
  };

  const markdown = `Showing ${rows.length} of ${totalKnown} jobs — table below.`;
  return { block, markdown };
}
