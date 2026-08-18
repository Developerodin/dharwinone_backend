// Shared Sage-style count phrasing for deterministic renderers.

function pluralise(label, n) {
  if (n === 1 && label.endsWith('s')) return label.slice(0, -1);
  return label;
}

/**
 * @param {string} label e.g. "employees", "agents"
 * @param {number} total
 * @param {{ active?: number, resigned?: number, hiddenDisabledTotal?: number, hiddenDisabledResigned?: number }} [breakdown]
 * @param {{ statusHint?: 'active'|'current'|null }} [opts]
 */
export function renderSageCount(label, total, breakdown, opts = {}) {
  const noun = pluralise(label, total);
  const hint = opts.statusHint;

  if (hint === 'active' || hint === 'current') {
    const n = breakdown?.active ?? total;
    return n === 1 ? '**1** is active.' : `**${n}** are active.`;
  }

  if (breakdown && typeof breakdown.active === 'number' && typeof breakdown.resigned === 'number') {
    const hiddenTotal = breakdown.hiddenDisabledTotal ?? 0;
    let text =
      `**${total}** ${noun} — **${breakdown.active}** currently working, **${breakdown.resigned}** resigned.`;
    if (hiddenTotal) {
      const hidRes = breakdown.hiddenDisabledResigned ?? 0;
      text +=
        ` ${hiddenTotal} more (${hidRes} resigned) ${hiddenTotal === 1 ? 'is' : 'are'} ` +
        'not counted because their account is disabled.';
    }
    return text;
  }

  return total === 1 ? `**1** ${noun.slice(0, -1) || noun}.` : `**${total}** ${noun}.`;
}
