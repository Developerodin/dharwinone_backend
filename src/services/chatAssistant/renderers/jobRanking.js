import { formatJobSalary } from '../queryPlanner/entities/jobRank.js';

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const formatOrg = (r) => {
  const o = r.organisation;
  if (!o) return '';
  if (typeof o === 'string') return o;
  return o.name || '';
};

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
  const statusLabel = filters.status ? `${filters.status.toLowerCase()} ` : 'active ';

  if (!jobs.length) {
    return `I couldn't find any ${statusLabel}jobs with a specified salary that match your filters.`;
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
    const salary = formatJobSalary(j);
    const orgPart = org ? ` at **${org}**` : '';
    if (ordinal) {
      return `The ${ordinal}${direction}-paying ${statusLabel.trim()} job is **${cell(j.title)}**${orgPart} — salary **${salary}**.`;
    }
    return `The ${direction}-paying ${statusLabel.trim()} job right now is **${cell(j.title)}**${orgPart} — salary **${salary}**.`;
  }

  const title =
    plan?.direction === 'asc'
      ? `Lowest-paying ${statusLabel.trim()} jobs`
      : `Top ${jobs.length} highest-paying ${statusLabel.trim()} jobs`;

  const lead = `Here are the ${jobs.length} ${direction}-paying ${statusLabel.trim()} jobs (${total} with salary on file) — ranked list below.`;
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
    const pairs = [
      { k: 'Title', v: cell(j.title) },
      { k: 'Company', v: cell(formatOrg(j)) },
      { k: 'Type', v: cell(j.jobType) },
      { k: 'Location', v: cell(j.location) },
      { k: 'Experience', v: cell(j.experienceLevel) },
      { k: 'Salary', v: cell(formatJobSalary(j)) },
      { k: 'Status', v: cell(j.status || 'Active') },
      { k: 'Origin', v: cell(j._origin || (j.jobOrigin === 'external' ? 'External' : 'Internal')) },
    ].filter((p) => p.v && p.v !== '—');

    const block = {
      type: 'kv',
      id: 'job-ranking-single',
      title: `Job: ${cell(j.title)}`,
      pairs,
    };
    return { block, markdown: reply };
  }

  const rows = jobs.map((j) => ({
    rank: cell(j.rank),
    title: cell(j.title),
    organisation: cell(formatOrg(j)),
    jobType: cell(j.jobType),
    location: cell(j.location),
    salary: cell(j.salaryLabel || formatJobSalary(j)),
    status: { v: cell(j.status || 'Active'), tone: statusTone(j.status) },
  }));

  const statusLabel = plan?.filters?.status ? String(plan.filters.status).toLowerCase() : 'active';
  const title =
    plan?.direction === 'asc'
      ? `Lowest-paying ${statusLabel} jobs`
      : `Top ${jobs.length} highest-paying ${statusLabel} jobs`;

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
