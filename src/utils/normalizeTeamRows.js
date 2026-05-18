const KNOWN_HEADERS = new Set([
  'Team Name', 'Team Lead Email', 'Department', 'Description',
  'Employee Internal ID', 'Employee ID', 'Employee Email', 'Employee Name',
  'Team Seniority',
]);

const norm = (v) => String(v ?? '').trim();
const lower = (v) => norm(v).toLowerCase();
const teamKey = (n) => norm(n).toLowerCase().replace(/\s+/g, ' ');

export function normalizeRows(rawRows) {
  const teams = new Map();
  const unknownColumns = new Set();

  for (const raw of rawRows) {
    for (const k of Object.keys(raw)) if (!KNOWN_HEADERS.has(k)) unknownColumns.add(k);
    const tn = teamKey(raw['Team Name']);
    if (!tn) continue;

    let entry = teams.get(tn);
    if (!entry) {
      entry = {
        teamName: norm(raw['Team Name']),
        meta: { teamLeadEmail: undefined, department: undefined, description: undefined },
        memberRows: [],
        metadataConflicts: [],
      };
      teams.set(tn, entry);
    }

    const setOnce = (field, headerKey) => {
      const v = norm(raw[headerKey]);
      if (!v) return;
      if (!entry.meta[field]) entry.meta[field] = v;
      else if (entry.meta[field] !== v)
        entry.metadataConflicts.push({ field, kept: entry.meta[field], ignored: v });
    };
    setOnce('teamLeadEmail', 'Team Lead Email');
    setOnce('department',    'Department');
    setOnce('description',   'Description');

    entry.memberRows.push({
      employeeInternalId: norm(raw['Employee Internal ID']),
      employeeId:         norm(raw['Employee ID']),
      employeeEmail:      lower(raw['Employee Email']),
      employeeName:       norm(raw['Employee Name']),
      teamSeniority:      norm(raw['Team Seniority']) || 'Member',
    });
  }

  for (const t of teams.values()) {
    if (t.meta.teamLeadEmail) t.meta.teamLeadEmail = t.meta.teamLeadEmail.toLowerCase();
  }

  return {
    teams,
    warnings: { unknownColumns: [...unknownColumns] },
  };
}
