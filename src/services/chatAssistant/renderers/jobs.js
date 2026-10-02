// uat.dharwin.backend/src/services/chatAssistant/renderers/jobs.js
//
// Render `fetch_jobs` retrieval as a TableBlock when records are present.
// Also renders atomic `job_result` envelopes — count + rows from one query.

import { renderGenericCount } from './genericCount.js';
import {
  originLabelFromFilters,
  buildJobCountPhrase,
  jobMatchesOrigin,
} from '../jobResult.js';
import { formatSalaryRange } from '../jobFieldMap.js';
import { htmlToReadable } from '../htmlText.js';

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

// Reuse the canonical formatter (jobFieldMap.js) instead of a second,
// slightly different implementation living here — that duplication is what
// produced the unformatted "USD50000–80000" bug (issue 4).
const formatSalary = (r) => formatSalaryRange(r.salaryRange);

const formatOrg = (r) => {
  const o = r.organisation;
  if (!o) return '';
  if (typeof o === 'string') return o;
  return o.name || '';
};

// ISO string so the frontend's `format: 'date'` cell renderer (IST-safe;
// see StructuredResponse.tsx) can parse it; raw Mongo Date objects stringify
// to a verbose, timezone-ambiguous form.
const isoDate = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

const JOB_COLUMNS = [
  { key: 'title',               label: 'Title',      priority: 'primary' },
  { key: 'organisation',        label: 'Company',    priority: 'secondary' },
  { key: 'jobType',             label: 'Type',       priority: 'secondary' },
  { key: 'location',            label: 'Location',   priority: 'secondary' },
  { key: 'experienceLevel',     label: 'Experience', priority: 'secondary' },
  { key: 'salary',              label: 'Salary',     priority: 'secondary' },
  { key: 'vacancies',           label: 'Openings',   priority: 'secondary', format: 'number' },
  { key: 'applicationDeadline', label: 'Deadline',   priority: 'secondary', format: 'date' },
  { key: 'createdAt',           label: 'Posted',     priority: 'secondary', format: 'date' },
  { key: 'origin',              label: 'Origin',     priority: 'secondary' },
  { key: 'status',              label: 'Status',     priority: 'primary', format: 'badge' },
];

/**
 * Table/list title. When fewer rows were returned than actually match (the
 * list is capped, e.g. 50 of 237), the title must say so — otherwise it
 * reads as if all matches are in the table (issue 6).
 * @param {string} noun
 * @param {number} rowCount
 * @param {number} total
 */
function buildListTitle(noun, rowCount, total) {
  if (rowCount < total) return `${noun} — showing first ${rowCount} of ${total}`;
  return `${noun} (${total})`;
}

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
    // KVBlock pairs are { label, value, tone? } on the wire (chatResponse.ts,
    // KV.tsx reads p.label/p.value) — {k,v} silently rendered a blank card.
    const optionalPairs = [
      { label: 'Company',    value: cell(formatOrg(r)) },
      { label: 'Type',       value: cell(r.jobType) },
      { label: 'Location',   value: cell(r.location) },
      { label: 'Experience', value: cell(r.experienceLevel) },
      { label: 'Salary',     value: cell(formatSalary(r)) },
      { label: 'Openings',   value: cell(r.vacancies) },
      { label: 'Deadline',   value: cell(isoDate(r.applicationDeadline)) },
      { label: 'Posted',     value: cell(isoDate(r.createdAt)) },
      { label: 'Recruiter',  value: cell(r.recruiterName) },
      { label: 'Origin',     value: cell(r._origin || (r.jobOrigin === 'external' ? 'External' : 'Internal')) },
    ].filter((p) => p.value && p.value !== '—');
    const pairs = [
      { label: 'Title',  value: cell(r.title) },
      // Status is never guessed — an unknown status shows '—' rather than
      // silently claiming "Active" (issue 5), so it stays out of the
      // emptiness filter that drops the other optional pairs above.
      { label: 'Status', value: cell(r.status) },
      ...optionalPairs,
    ];
    if (Array.isArray(r.skillTags) && r.skillTags.length) {
      pairs.push({ label: 'Skills', value: r.skillTags.join(', ') });
    }
    if (Array.isArray(r.skillRequirements) && r.skillRequirements.length) {
      const fmtSkill = (s) => (s.level ? `${s.name} (${s.level})` : s.name);
      const required = r.skillRequirements.filter((s) => s.required !== false).map(fmtSkill);
      const preferred = r.skillRequirements.filter((s) => s.required === false).map(fmtSkill);
      if (required.length) pairs.push({ label: 'Required skills', value: required.join(', ') });
      if (preferred.length) pairs.push({ label: 'Preferred skills', value: preferred.join(', ') });
    }
    if (r.jobDescription) {
      const text = htmlToReadable(r.jobDescription).slice(0, 480);
      if (text) pairs.push({ label: 'Description', value: text });
    }
    if (r.jobUrl) {
      pairs.push({ label: 'Job link', value: r.jobUrl });
    }
    if (r.externalPlatformUrl) {
      pairs.push({ label: 'Source URL', value: r.externalPlatformUrl });
    }
    const block = {
      type: 'kv',
      id: 'job-detail',
      title: `Job: ${cell(r.title)}`,
      pairs,
    };
    // Table/kv cells render plain text, not markdown (StructuredResponse.tsx
    // / KV.tsx) — the reply/markdown "twin" is the only surface that renders
    // a real, clickable link (issue 1), so that's where it goes.
    const markdown = r.jobUrl
      ? `Here are the details for **${cell(r.title)}** — see below. [Open job page](${r.jobUrl})`
      : `Here are the details for **${cell(r.title)}** — see below.`;
    return { block, markdown };
  }

  const rows = records.map((r) => ({
    title:               cell(r.title),
    organisation:        cell(formatOrg(r)),
    jobType:             cell(r.jobType),
    location:            cell(r.location),
    experienceLevel:     cell(r.experienceLevel),
    salary:              cell(formatSalary(r)),
    vacancies:           cell(r.vacancies),
    applicationDeadline: cell(isoDate(r.applicationDeadline)),
    createdAt:           cell(isoDate(r.createdAt)),
    origin:              { v: cell(r._origin || (r.jobOrigin === 'external' ? 'External' : 'Internal')), tone: originTone(r.jobOrigin) },
    status:              { v: cell(r.status), tone: statusTone(r.status) },
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

  const title = buildListTitle('Jobs', rows.length, totalKnown);
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

/**
 * Render atomic job_result — rows always match authoritative total + origin filters.
 *
 * @param {object|null} payload
 * @param {{ listIntent?: boolean }} ctx
 */
export function renderJobResult(payload, ctx = {}) {
  if (!payload) return { block: null, markdown: '' };

  const total = Number(
    payload?.result?.total
    ?? payload?.authoritativeCount
    ?? payload?.total
    ?? 0,
  );
  const jobs = payload?.result?.jobs ?? payload?.rows ?? [];
  const filters = payload?.query?.filters ?? payload?.filters ?? {};
  const queryId = payload?.query?.queryId ?? payload?.queryId ?? null;
  const listIntent = ctx?.listIntent ?? payload?.intent === 'list';
  const originLabel = originLabelFromFilters(filters);
  const countNoun = buildJobCountPhrase(filters, total);

  if (!listIntent) {
    const markdown = total === 1
      ? `There is **1** ${countNoun}.`
      : `There are **${total}** ${countNoun}.`;
    return { block: null, markdown };
  }

  if (!jobs.length) {
    const markdown = `No ${countNoun} matched your filters.`;
    return { block: null, markdown };
  }

  if (filters.jobOrigin) {
    for (const j of jobs) {
      if (!jobMatchesOrigin(j, filters.jobOrigin)) {
        return { block: null, markdown: `No matching ${countNoun}.` };
      }
    }
  }

  const rows = jobs.slice(0, Math.min(jobs.length, total)).map((r) => ({
    title: cell(r.title),
    organisation: cell(formatOrg(r)),
    jobType: cell(r.jobType),
    location: cell(r.location),
    experienceLevel: cell(r.experienceLevel),
    salary: cell(formatSalary(r)),
    vacancies: cell(r.vacancies),
    applicationDeadline: cell(isoDate(r.applicationDeadline)),
    createdAt: cell(isoDate(r.createdAt)),
    origin: {
      v: cell(r._origin || (r.jobOrigin === 'external' ? 'External' : 'Internal')),
      tone: originTone(r.jobOrigin),
    },
    status: { v: cell(r.status), tone: statusTone(r.status) },
  }));

  const columns = JOB_COLUMNS.filter((col) =>
    rows.some((row) => {
      const v = row[col.key];
      const text = v && typeof v === 'object' ? v.v : v;
      return text && text !== '—' && text !== '';
    }),
  );

  if (!columns.length) {
    return { block: null, markdown: `Found **${total}** ${countNoun}.` };
  }

  const title = buildListTitle(originLabel ? `${originLabel} Jobs` : 'Jobs', rows.length, total);

  const block = {
    type: 'table',
    id: 'jobs',
    tableType: 'jobs',
    title,
    columns,
    rows,
    layout: 'auto',
    queryId,
    pagination: { total },
  };

  const markdown = `Showing ${rows.length} of ${total} ${countNoun} — table below.`;
  return { block, markdown };
}
