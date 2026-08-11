// Key-value profile table for explicit full-profile requests only.

function humanizeKey(key) {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatFieldValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'object' && v.name) return String(v.name);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * @param {Awaited<ReturnType<import('./index.js').resolvePersonProfile>>} profile
 * @returns {object|null}
 */
export function buildProfileTableBlock(profile) {
  if (profile?.kind !== 'unique') return null;

  const { name, roles } = profile.identity;
  const rows = [];

  rows.push({ field: 'Name', value: name || '—' });
  if (roles?.length) {
    rows.push({ field: 'Business role', value: roles.join(', ') });
  }

  for (const [roleKey, p] of Object.entries(profile.profiles || {})) {
    if (p?.error || p?.noRecord) continue;
    for (const key of p.visibleFields || []) {
      const val = formatFieldValue(p.fields?.[key]);
      if (val === '—') continue;
      const label = roleKey === 'employee' ? humanizeKey(key) : `${humanizeKey(roleKey)} — ${humanizeKey(key)}`;
      rows.push({ field: label, value: val });
    }
  }

  if (rows.length <= 1) return null;

  return {
    type: 'table',
    id: 'person_profile',
    tableType: 'profile',
    title: name || 'Profile',
    columns: [
      { key: 'field', label: 'Field', priority: 'primary' },
      { key: 'value', label: 'Value', priority: 'primary' },
    ],
    rows: rows.map((r) => ({ field: r.field, value: r.value })),
    layout: 'auto',
  };
}
