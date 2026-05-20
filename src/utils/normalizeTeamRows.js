/** Normalize Excel header text for alias lookup: trim, lowercase, collapse whitespace. */
export function headerAliasKey(k) {
  return String(k ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Maps normalized header → canonical column name used by import/export. */
export const CANONICAL_HEADER_BY_ALIAS = {
  'team name': 'Team Name',
  'team lead email': 'Team Lead Email',
  department: 'Department',
  description: 'Description',
  'employee internal id': 'Employee Internal ID',
  'employee id': 'Employee ID',
  'employee email': 'Employee Email',
  'employee name': 'Employee Name',
  'team seniority': 'Team Seniority',
};

/**
 * Which canonical headers appear in the sheet's first object row (keys may be any casing).
 * @param {Record<string, unknown>} firstRow
 * @returns {Set<string>}
 */
export function canonicalHeadersPresent(firstRow) {
  const present = new Set();
  for (const k of Object.keys(firstRow || {})) {
    const canon = CANONICAL_HEADER_BY_ALIAS[headerAliasKey(k)];
    if (canon) present.add(canon);
  }
  return present;
}

/**
 * Map one sheet_json row to canonical header keys only.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function mapRowToCanonical(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const canon = CANONICAL_HEADER_BY_ALIAS[headerAliasKey(k)];
    if (canon) out[canon] = v;
  }
  return out;
}

const norm = (v) => String(v ?? '').trim();
const lower = (v) => norm(v).toLowerCase();
const teamKey = (n) => norm(n).toLowerCase().replace(/\s+/g, ' ');

export function normalizeRows(rawRows) {
  const teams = new Map();
  const unknownColumns = new Set();

  for (const rawOriginal of rawRows) {
    for (const k of Object.keys(rawOriginal)) {
      if (!CANONICAL_HEADER_BY_ALIAS[headerAliasKey(k)]) unknownColumns.add(k);
    }
    const raw = mapRowToCanonical(rawOriginal);
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
    setOnce('department', 'Department');
    setOnce('description', 'Description');

    entry.memberRows.push({
      employeeInternalId: norm(raw['Employee Internal ID']),
      employeeId: norm(raw['Employee ID']),
      employeeEmail: lower(raw['Employee Email']),
      employeeName: norm(raw['Employee Name']),
      teamSeniority: norm(raw['Team Seniority']) || 'Member',
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
