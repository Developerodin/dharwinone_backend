// uat.dharwin.backend/src/services/chatAssistant/renderers/employees.js
//
// Render the `fetch_employees` retrieval payload as a TableBlock plus a
// markdown twin (kept in lockstep so old clients still see a sensible
// answer). Returns null when the data is empty — caller falls through to
// the fallback generator.
//
// Column selection is delegated to ../columnVisibility.js:
//   - default profile per queried role (no Role/Dept unless asked),
//   - per-role ACL (employeeId only for viewer role 'employee'),
//   - empty-column prune (>70% empty rows → hide).
//
// Input shape (subset of fetch_employees data we read):
//   {
//     records: [{ name, employeeId, employmentState, role|roleNames,
//                 department, designation, email, appliedRole, ... }],
//     total: number,
//     requestedRole: string|null,
//     notFound: boolean,
//     page?: { from, to, total, hasMore },
//   }

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

const roleOf = (r) => {
  const names = roleNamesOf(r);
  return names.length ? names.join(', ') : '—';
};

const isEmployeeRecord = (r) => roleNamesOf(r).some((n) => /employee/i.test(String(n)));

const formatDate = (d) => {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toISOString().slice(0, 10);
};

// Accept legacy/alternate backend field names for employee ID + resign date.
const pickEmployeeId = (r) => r.employeeId || r.empId || r.employee_code || '';
const pickResignDate = (r) => r.resignDate || r.resignationDate || r.exitDate || '';
const pickJoinDate   = (r) => r.joiningDate || r.joinDate || r.dateOfJoining || '';

// Full set of keys this renderer KNOWS how to populate. The visibility
// layer picks the subset that the viewer + query actually deserve.
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
 * @param {object} data
 * @param {{ role?:string, queryArg?:string, viewerRole?:string }} [ctx]
 * @returns {{ block:object, markdown:string } | null}
 */
export function renderEmployees(data, ctx = {}) {
  if (!data || data.notFound) return null;
  const records = Array.isArray(data.records) ? data.records : [];
  if (!records.length) return null;

  const role = data.requestedRole || ctx.role || null;
  const total = Number(data.total ?? records.length);
  const titleNoun = role ? `${role}s` : 'Employees';
  const viewerRole = ctx.viewerRole || VIEWER_ROLES.OTHER;

  // Build full-fat rows. Employee ID is gated PER ROW — only records whose
  // role contains "Employee" get an ID rendered; admins/clients/candidates/
  // students see a blank cell (rendered as "—"; pruned away if every row in
  // the table is blank, e.g. an agents-only table).
  // Resign date is blanked when unset OR still in the future (filed but not
  // yet effective). Join date is shown whenever present.
  const rawRows = records.map((r) => ({
    name:        cell(r.name),
    employeeId:  cell(isEmployeeRecord(r) ? pickEmployeeId(r) : ''),
    appliedRole: cell(r.appliedRole || r.designation),
    email:       cell(r.email),
    role:        roleOf(r),
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

  // Pathological case — every column got stripped. Bail rather than emit
  // an empty table so the fallback path can take over.
  if (!columns.length) return null;

  /** @type {object} */
  const block = {
    type: 'table',
    id: 'employees',
    tableType: tableTypeFor(role),
    title: `${titleNoun} (${total})`,
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

  // Markdown twin — derived from the SAME visible columns so legacy
  // (non-block) clients see exactly what block-aware clients see.
  const markdown = buildMarkdownTwin({ columns, rows, total, page: data.page });

  return { block, markdown };
}

function tableTypeFor(role) {
  const k = String(role || '').toLowerCase();
  if (k === 'agent' || k === 'salesagent') return 'agents';
  if (k === 'recruiter') return 'recruiters';
  if (k === 'candidate') return 'candidates';
  if (k === 'student')   return 'students';
  if (k === 'employee')  return 'employees';
  return 'employees';
}

function buildMarkdownTwin({ columns, rows, total, page }) {
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
    : `\nTotal: ${total}.`;
  return [header, sep, ...mdRows, footer].join('\n');
}
