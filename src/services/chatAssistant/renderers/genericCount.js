// uat.dharwin.backend/src/services/chatAssistant/renderers/genericCount.js
//
// Generic count renderer — used for any fact-kind whose primary value is
// a single number with optional sub-breakdown (jobs, candidates, roles,
// placements, offers, leave_requests, backdated_attendance_requests).
// Output: GroupBlock containing a KV summary + optional BadgeRow with
// sub-counts. Markdown twin matches legacy factRenderer one-line style
// extended with the sub-breakdown when present.
//
// Input shape (verbatim from factExtractor.js generic readers):
//   { kind, label, total: number, role?: string,
//     breakdown?: { active, resigned, ... },
//     typeBreakdown?: object,
//     statusFilter?: string }

function pluralLabel(label, n) {
  if (!label) return 'records';
  if (n === 1 && label.endsWith('s')) return label.slice(0, -1);
  return label;
}

function toneFor(label) {
  const v = String(label || '').toLowerCase();
  if (v === 'active' || v === 'open' || v === 'approved' || v === 'placed') return 'success';
  if (v === 'resigned' || v === 'closed' || v === 'rejected') return 'neutral';
  if (v === 'pending')  return 'warn';
  if (v === 'cancelled' || v === 'expired') return 'danger';
  return 'info';
}

/**
 * @param {{
 *   kind: string,
 *   label: string,
 *   total: number,
 *   role?: string,
 *   breakdown?: object,
 *   typeBreakdown?: object,
 *   statusFilter?: string,
 * }} fact
 * @param {{ queryArg?:string }} [_ctx]
 * @returns {{ block:object|null, markdown:string } | null}
 */
export function renderGenericCount(fact, _ctx = {}) {
  if (!fact || typeof fact.total !== 'number') return null;
  const total = fact.total;
  const labelNoun = pluralLabel(fact.role ? `${fact.role.toLowerCase()}s` : fact.label, total);
  const titleNoun = fact.role ? `${fact.role}s` : (fact.label || 'records');

  const subPairs = collectPairs(fact);

  /** @type {object} */
  const summary = {
    type: 'kv',
    title: `${titleNoun} (${total})`,
    pairs: [
      { label: 'Total', value: String(total) },
      ...(fact.statusFilter ? [{ label: 'Status filter', value: String(fact.statusFilter) }] : []),
    ],
  };

  /** @type {object[]} */
  const blocks = [summary];
  if (subPairs.length) {
    blocks.push({
      type: 'badge_row',
      chips: subPairs.map(([k, v]) => ({ label: k, tone: toneFor(k), count: Number(v) || 0 })),
    });
  }

  /** @type {object} */
  const group = {
    type: 'group',
    title: `${titleNoun} (${total})`,
    collapsible: false,
    blocks,
  };

  const head = `We have **${total} ${labelNoun}** in total.`;
  const sub = subPairs.length
    ? '\n\n' + subPairs.map(([k, v]) => `- **${k}:** ${v}`).join('\n')
    : '';
  const filter = fact.statusFilter ? `\n\n_Filter: \`status=${fact.statusFilter}\`._` : '';
  const markdown = head + sub + filter;

  return { block: group, markdown };
}

/**
 * Flatten breakdown / typeBreakdown into deterministic [label, count] pairs.
 * Order: known status terms first (active → resigned → ...), then alpha.
 */
function collectPairs(fact) {
  /** @type {[string, number][]} */
  const pairs = [];
  const seen = new Set();
  const push = (label, value) => {
    if (typeof value !== 'number') return;
    const k = String(label || '').trim();
    if (!k || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    pairs.push([k.charAt(0).toUpperCase() + k.slice(1), value]);
  };

  const ordered = ['active', 'resigned', 'open', 'closed', 'pending', 'approved', 'rejected', 'cancelled'];
  const sources = [fact.breakdown, fact.typeBreakdown].filter(Boolean);
  for (const src of sources) {
    for (const k of ordered) if (k in src) push(k, src[k]);
    for (const k of Object.keys(src)) if (!ordered.includes(k.toLowerCase())) push(k, src[k]);
  }
  return pairs;
}
