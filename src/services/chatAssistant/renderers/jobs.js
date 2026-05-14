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

  // Single-job detail intent (issue 3): when the caller asked for a specific
  // job (search/jobId) and exactly one record came back, render a KV detail
  // block instead of a multi-row table. Same when exactly one job exists.
  // Prevents the UI from "rendering all jobs" when the user only asked one.
  const wantDetail = !!data?.wantDetail || records.length === 1;
  if (wantDetail && records.length === 1) {
    const r = records[0];
    const pairs = [
      { k: 'Title',      v: cell(r.title) },
      { k: 'Company',    v: cell(formatOrg(r)) },
      { k: 'Type',       v: cell(r.jobType) },
      { k: 'Location',   v: cell(r.location) },
      { k: 'Experience', v: cell(r.experienceLevel) },
      { k: 'Salary',     v: cell(formatSalary(r)) },
      { k: 'Status',     v: cell(r.status || 'Active') },
      { k: 'Origin',     v: cell(r._origin || (r.jobOrigin === 'external' ? 'External' : 'Internal')) },
    ].filter((p) => p.v && p.v !== '—');
    if (Array.isArray(r.skillTags) && r.skillTags.length) {
      pairs.push({ k: 'Skills', v: r.skillTags.join(', ') });
    }
    if (r.jobDescription) {
      pairs.push({ k: 'Description', v: String(r.jobDescription).replace(/\s+/g, ' ').slice(0, 480) });
    }
    if (r.externalPlatformUrl) {
      pairs.push({ k: 'Source URL', v: r.externalPlatformUrl });
    }
    const block = {
      type: 'kv',
      id: 'job-detail',
      title: `Job: ${cell(r.title)}`,
      pairs,
    };
    const markdown = `Here are the details for **${cell(r.title)}** — see below.`;
    return { block, markdown };
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
