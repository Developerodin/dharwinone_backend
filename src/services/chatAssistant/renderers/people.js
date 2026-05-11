// uat.dharwin.backend/src/services/chatAssistant/renderers/people.js
//
// Render `fetch_people` (twoStage listing path). Wraps the legacy
// listingRenderer for the markdown twin only on empty / notFound — populated
// markdown is rebuilt from the visible-column subset so it cannot drift away
// from the structured block.
//
// Column selection routes through ../columnVisibility.js so the same RBAC
// + profile + emptiness rules used in employees.js apply here verbatim.

import { renderListing } from '../listingRenderer.js';
import {
  applyColumnVisibility,
  profileForRole,
  VIEWER_ROLES,
} from '../columnVisibility.js';

const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const stateTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'active') return 'success';
  if (v === 'resigned' || v === 'terminated') return 'neutral';
  if (v === 'probation') return 'info';
  if (v === 'on leave' || v === 'onleave') return 'warn';
  return 'neutral';
};

const roleNamesOf = (r) => {
  if (Array.isArray(r.roleNames) && r.roleNames.length) return r.roleNames;
  if (Array.isArray(r.role) && r.role.length) return r.role;
  if (r.role) return [r.role];
  return [];
};

const isEmployeeRecord = (r) => roleNamesOf(r).some((n) => /employee/i.test(String(n)));

const formatDate = (d) => {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toISOString().slice(0, 10);
};

const pickEmployeeId = (r) => r.employeeId || r.empId || r.employee_code || '';
const pickResignDate = (r) => r.resignDate || r.resignationDate || r.exitDate || '';
const pickJoinDate   = (r) => r.joiningDate || r.joinDate || r.dateOfJoining || '';

const CANDIDATE_COLUMNS = [
  { key: 'name',        label: 'Name',         priority: 'primary' },
  { key: 'employeeId',  label: 'Employee ID',  priority: 'primary',   format: 'mono' },
  { key: 'appliedRole', label: 'Applied Role', priority: 'primary' },
  { key: 'email',       label: 'Email',        priority: 'secondary' },
  { key: 'role',        label: 'Role',         priority: 'secondary' },
  { key: 'department',  label: 'Dept',         priority: 'secondary' },
  { key: 'joinDate',    label: 'Join Date',    priority: 'secondary', format: 'date' },
  { key: 'resignDate',  label: 'Resign Date',  priority: 'secondary', format: 'date' },
  { key: 'status',      label: 'Status',       priority: 'primary',   format: 'badge' },
];

/**
 * @param {{
 *   records: object[],
 *   page: { from:number, to:number, total:number, hasMore:boolean },
 *   role?: string,
 *   notFound?: boolean,
 *   searchedFor?: string,
 * }} data
 * @param {{ role?:string, queryArg?:string, viewerRole?:string }} [ctx]
 * @returns {{ block:object|null, markdown:string }}
 */
export function renderPeople(data, ctx = {}) {
  if (!data) return { block: null, markdown: '' };
  const role = data.role || ctx.role || 'Employee';
  const records = Array.isArray(data.records) ? data.records : [];
  const searchedFor = data.searchedFor ?? ctx.queryArg ?? null;

  // Empty / notFound — defer to the legacy listing markdown (handles "No
  // <Role> matching '<query>'" copy + suggestions). Caller routes to
  // fallbackGenerator for the structured block.
  if (data.notFound || !records.length) {
    const markdown = renderListing({
      records,
      page: data.page || { from: 0, to: 0, total: 0, hasMore: false },
      role,
      notFound: !!data.notFound,
      searchedFor,
    });
    return { block: null, markdown };
  }

  const viewerRole = ctx.viewerRole || VIEWER_ROLES.OTHER;

  const rawRows = records.map((r) => ({
    name:        cell(r.name),
    employeeId:  cell(isEmployeeRecord(r) ? pickEmployeeId(r) : ''),
    appliedRole: cell(r.appliedRole || r.designation),
    email:       cell(r.email),
    role:        Array.isArray(r.role) ? r.role.join(', ') : cell(r.role),
    department:  cell(r.department || r.designation),
    joinDate:    cell(formatDate(pickJoinDate(r))),
    resignDate:  cell(formatDate(pickResignDate(r))),
    status:      { v: cell(r.employmentState), tone: stateTone(r.employmentState) },
  }));

  const { columns, rows } = applyColumnVisibility({
    candidateColumns: CANDIDATE_COLUMNS,
    rows: rawRows,
    viewerRole,
    profile: profileForRole(role),
    queryArg: ctx.queryArg || '',
  });

  if (!columns.length) {
    const markdown = renderListing({
      records,
      page: data.page || { from: 0, to: 0, total: 0, hasMore: false },
      role,
      notFound: false,
      searchedFor,
    });
    return { block: null, markdown };
  }

  /** @type {object} */
  const block = {
    type: 'table',
    id: 'people',
    tableType: tableTypeFor(role),
    title: `${role}s (${data.page?.total ?? records.length})`,
    columns,
    rows,
    layout: 'auto',
  };
  if (data.page) {
    block.pagination = {
      from: data.page.from,
      to: data.page.to,
      total: data.page.total,
      hasMore: !!data.page.hasMore,
    };
  }

  const markdown = buildMarkdownTwin({ columns, rows, page: data.page, total: records.length });
  return { block, markdown };
}

function tableTypeFor(role) {
  const k = String(role || '').toLowerCase();
  if (k === 'agent' || k === 'salesagent') return 'agents';
  if (k === 'recruiter') return 'recruiters';
  if (k === 'candidate') return 'candidates';
  if (k === 'student')   return 'students';
  if (k === 'employee')  return 'employees';
  return 'people';
}

function buildMarkdownTwin({ columns, rows, page, total }) {
  const labels = columns.map((c) => c.label);
  const header = `| ${labels.join(' | ')} |`;
  const sep    = `| ${labels.map(() => '---').join(' | ')} |`;
  const mdRows = rows.map((r) => {
    const cells = columns.map((c) => {
      const v = r[c.key];
      if (v && typeof v === 'object' && 'v' in v) return v.v;
      return v ?? '—';
    });
    return `| ${cells.join(' | ')} |`;
  });
  const footer = page?.hasMore
    ? `\nShowing ${page.from}–${page.to} of ${page.total}.`
    : `\nTotal: ${page?.total ?? total}.`;
  return [header, sep, ...mdRows, footer].join('\n');
}
