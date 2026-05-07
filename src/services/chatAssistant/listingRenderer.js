/**
 * Render a fetchPeople result into a deterministic markdown block the LLM
 * can emit verbatim. Includes a header row, one row per record, and a
 * pagination footer.
 *
 * @param {object} args
 * @param {Array<object>} args.records
 * @param {{from:number, to:number, total:number, hasMore:boolean}} args.page
 * @param {string} args.role             Canonical role name ('Employee', 'Agent', ...)
 * @param {boolean} [args.notFound]
 * @param {string}  [args.searchedFor]
 * @returns {string} Markdown block
 */
export function renderListing({ records, page, role, notFound = false, searchedFor = null }) {
  if (notFound || (records.length === 0 && searchedFor)) {
    return `No ${role} matching '${searchedFor || ''}'.`;
  }
  if (records.length === 0) {
    return `No ${role}s found.`;
  }

  const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const header = '| Name | EmpID | Role | Dept | Status |';
  const sep    = '| --- | --- | --- | --- | --- |';
  const rows   = records.map((r) =>
    `| ${cell(r.name)} | ${cell(r.employeeId)} | ${cell((r.role || []).join(', '))} | ${cell(r.department || r.designation)} | ${cell(r.employmentState)} |`
  );

  let footer;
  if (page.hasMore) {
    footer = `\nShowing ${page.from}–${page.to} of ${page.total}. Reply 'next' for more.`;
  } else {
    footer = `\nEnd of list — ${page.total} total.`;
  }

  const multiRole = records.some((r) => Array.isArray(r.role) && r.role.length > 1);
  if (multiRole) footer += '\n_Some people hold multiple roles._';

  return [header, sep, ...rows, footer].join('\n');
}
