import { buildJobPageUrl } from '../jobResult.js';
import { formatSalaryRange } from '../jobFieldMap.js';

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const formatOrg = (r) => {
  const o = r.organisation;
  if (!o) return '';
  if (typeof o === 'string') return o;
  return o.name || '';
};

// ISO string so the frontend's `format: 'date'` cell renderer (IST-safe;
// see StructuredResponse.tsx) can parse it.
const isoDate = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

// These ranked job objects come from jobRank.js's own `.lean()` query, not
// jobResult.js's mapJobRow, so there's no `jobId` field — but Mongoose
// `.lean()` docs always carry `_id` regardless of `.select()`.
const jobIdOf = (j) => (j?._id ? String(j._id) : j?.jobId ? String(j.jobId) : null);

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'active' || v === 'open') return 'success';
  if (v === 'closed' || v === 'filled') return 'neutral';
  if (v === 'draft' || v === 'pending') return 'warn';
  if (v === 'archived' || v === 'expired') return 'danger';
  return 'info';
};

/**
 * @param {object} plan
 * @param {{ jobs: object[], total: number }} result
 * @returns {string}
 */
export function formatJobRankingReply(plan, result) {
  const jobs = result?.jobs ?? [];
  const total = result?.total ?? jobs.length;
  const filters = plan?.filters ?? {};
  // 'active ' when the plan's status is Active (or unset — a legacy safety net;
  // planJobRankQuery now always sets one). status:'all' has no natural adjective form
  // ("all jobs" reads as a jobType, not a status), so it's named as a trailing note instead.
  const statusLabel = !filters.status
    ? 'active '
    : filters.status === 'all'
      ? ''
      : `${String(filters.status).toLowerCase()} `;
  const allStatusesSuffix = filters.status === 'all' ? ' across all statuses' : '';

  if (!jobs.length) {
    return `I couldn't find any ${statusLabel}jobs with a specified salary that match your filters${allStatusesSuffix}.`;
  }

  const direction = plan?.direction === 'asc' ? 'lowest' : 'highest';
  const ordinal =
    plan?.offset === 1 ? 'second ' :
    plan?.offset === 2 ? 'third ' :
    plan?.offset === 3 ? 'fourth ' :
    plan?.offset === 4 ? 'fifth ' :
    '';

  if (jobs.length === 1 && (plan?.limit === 1 || plan?.operation === 'MAX' || plan?.operation === 'MIN' || plan?.operation === 'RANK')) {
    const j = jobs[0];
    const org = formatOrg(j);
    const salary = cell(formatSalaryRange(j.salaryRange));
    const orgPart = org ? ` at **${org}**` : '';
    if (ordinal) {
      return `The ${ordinal}${direction}-paying ${statusLabel}job is **${cell(j.title)}**${orgPart} — salary **${salary}**${allStatusesSuffix}.`;
    }
    return `The ${direction}-paying ${statusLabel}job right now is **${cell(j.title)}**${orgPart} — salary **${salary}**${allStatusesSuffix}.`;
  }

  const title =
    plan?.direction === 'asc'
      ? `Lowest-paying ${statusLabel}jobs`
      : `Top ${jobs.length} highest-paying ${statusLabel}jobs`;

  const lead = `Here are the ${jobs.length} ${direction}-paying ${statusLabel}jobs (${total} with salary on file)${allStatusesSuffix} — ranked list below.`;
  return `${lead}\n\n**${title}**`;
}

/**
 * @param {object} plan
 * @param {{ jobs: object[], total: number }} result
 * @returns {{ block: object|null, markdown: string }}
 */
export function renderJobRanking(plan, result) {
  const jobs = result?.jobs ?? [];
  const reply = formatJobRankingReply(plan, result);

  if (!jobs.length) {
    return { block: null, markdown: reply };
  }

  if (jobs.length === 1 && (plan?.limit === 1 || plan?.operation === 'MAX' || plan?.operation === 'MIN' || plan?.operation === 'RANK')) {
    const j = jobs[0];
    // KVBlock pairs are { label, value, tone? } on the wire (chatResponse.ts,
    // KV.tsx reads p.label/p.value) — {k,v} silently rendered a blank card.
    const optionalPairs = [
      { label: 'Company', value: cell(formatOrg(j)) },
      { label: 'Type', value: cell(j.jobType) },
      { label: 'Location', value: cell(j.location) },
      { label: 'Experience', value: cell(j.experienceLevel) },
      { label: 'Salary', value: cell(formatSalaryRange(j.salaryRange)) },
      { label: 'Posted', value: cell(isoDate(j.createdAt)) },
      { label: 'Origin', value: cell(j._origin || (j.jobOrigin === 'external' ? 'External' : 'Internal')) },
    ].filter((p) => p.value && p.value !== '—');
    const pairs = [
      { label: 'Title', value: cell(j.title) },
      // Never guess a status — unknown shows '—' rather than "Active" (issue 5).
      { label: 'Status', value: cell(j.status) },
      ...optionalPairs,
    ];

    const block = {
      type: 'kv',
      id: 'job-ranking-single',
      title: `Job: ${cell(j.title)}`,
      pairs,
    };
    // kv cells render plain text, not markdown — the link only becomes
    // clickable in the reply text itself (issue 1).
    const jobUrl = buildJobPageUrl(jobIdOf(j));
    const markdown = jobUrl ? `${reply} [Open job page](${jobUrl})` : reply;
    return { block, markdown };
  }

  const rows = jobs.map((j) => ({
    rank: cell(j.rank),
    title: cell(j.title),
    organisation: cell(formatOrg(j)),
    jobType: cell(j.jobType),
    location: cell(j.location),
    // Recompute from salaryRange rather than trusting j.salaryLabel — that
    // field (set upstream in runJobEntityQuery.js/decorateRankedJobRows, out
    // of scope here) is pre-formatted through jobRank.js's own unformatted
    // formatJobSalary and would still print "USD50000-80000".
    salary: cell(formatSalaryRange(j.salaryRange)),
    status: { v: cell(j.status), tone: statusTone(j.status) },
  }));

  const status = plan?.filters?.status;
  const statusLabel = !status ? 'active ' : status === 'all' ? '' : `${String(status).toLowerCase()} `;
  const title =
    plan?.direction === 'asc'
      ? `Lowest-paying ${statusLabel}jobs`
      : `Top ${jobs.length} highest-paying ${statusLabel}jobs`;

  const block = {
    type: 'table',
    id: 'job-ranking',
    tableType: 'job-ranking',
    title,
    columns: [
      { key: 'rank', label: '#', priority: 'primary' },
      { key: 'title', label: 'Title', priority: 'primary' },
      { key: 'organisation', label: 'Company', priority: 'secondary' },
      { key: 'jobType', label: 'Type', priority: 'secondary' },
      { key: 'location', label: 'Location', priority: 'secondary' },
      { key: 'salary', label: 'Salary', priority: 'primary' },
      { key: 'status', label: 'Status', priority: 'secondary', format: 'badge' },
    ],
    rows,
    layout: 'auto',
  };

  return { block, markdown: reply };
}
