// uat.dharwin.backend/src/services/chatAssistant/responseValidator.js
//
// Post-LLM count enforcement. Compares numeric phrases in the LLM reply
// against authoritative retrieval facts. When a mismatch is detected the
// validator either:
//   1) rewrites the offending number in-place ("We have 5 agents" → "We have 7 agents"), AND
//   2) appends a single CORRECTION line at the end of the reply naming the
//      authoritative count, so the user sees the source of truth even if
//      they pattern-matched on the wrong figure.
//
// Returns: { reply, patched, mismatches }

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build patterns for each fact: matches "(\d+) (label|labels|role|roles)"
// optionally wrapped in markdown bold (`**N**`).
function buildPattern(fact) {
  const variants = new Set();
  if (fact.role) {
    // Role-scoped fact — match ONLY the role label. Don't include the generic
    // "employees" variant or we will rewrite legitimate employee counts in a
    // sentence that mentions both ("we have 7 agents and 126 employees").
    variants.add(fact.role.toLowerCase());
    variants.add(`${fact.role.toLowerCase()}s`);
  } else if (fact.label) {
    // Generic fact (no role) — match the label and its singular/plural pair.
    variants.add(fact.label);
    if (!fact.label.endsWith('s')) variants.add(`${fact.label}s`);
    if (fact.label.endsWith('s')) variants.add(fact.label.slice(0, -1));
  }
  if (variants.size === 0) return null;
  const escaped = [...variants].map(escapeForRegex).join('|');
  return new RegExp(`(\\*\\*)?(\\d+)(\\*\\*)?(\\s+)(${escaped})\\b`, 'gi');
}

/**
 * Walk every count fact and patch wrong numbers in the reply.
 *
 * @param {string} reply
 * @param {{ counts: object[] }} facts
 * @returns {{ reply: string, patched: boolean, mismatches: object[] }}
 */
export function enforceCounts(reply, facts) {
  const out = { reply: reply || '', patched: false, mismatches: [] };
  if (!facts || !Array.isArray(facts.counts) || !facts.counts.length) return out;

  for (const fact of facts.counts) {
    if (typeof fact.total !== 'number') continue;
    const pattern = buildPattern(fact);
    if (!pattern) continue;
    out.reply = out.reply.replace(pattern, (match, b1, num, b2, sep, noun) => {
      const found = Number(num);
      if (found === fact.total) return match;
      out.patched = true;
      out.mismatches.push({
        label: noun,
        expected: fact.total,
        found,
        source: fact.kind,
      });
      const bold1 = b1 || '';
      const bold2 = b2 || '';
      return `${bold1}${fact.total}${bold2}${sep}${noun}`;
    });
  }

  return out;
}

const RECORD_LIST_TYPES = new Set(['employee-list', 'project-list', 'task-list', 'jobs']);

function cellString(value) {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.v ?? '');
  return String(value);
}

function recordListBlocks(blocks) {
  return (blocks || []).filter((b) => b?.type === 'table' && RECORD_LIST_TYPES.has(b.tableType));
}

/** Case, whitespace and punctuation folded. Status/Stage, Assigned/Assignees, Due/Due date share a key. */
function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldKey(key) {
  const n = norm(key).replace(/\s+/g, '');
  if (/^(title|name|fullname|employeename|task|job)$/.test(n)) return 'identity';
  if (n === 'status' || n === 'stage') return 'stage';
  if (n === 'assigned' || n === 'assignee' || n === 'assignees') return 'assignees';
  if (n === 'due' || n === 'duedate') return 'due';
  return n;
}

function fieldsOf(row) {
  const fields = [];
  for (const [key, value] of Object.entries(row || {})) {
    const text = norm(cellString(value));
    if (text.length < 3 || text === 'unavailable') continue;
    fields.push({ key: fieldKey(key), text });
  }
  return fields;
}

function rowFields(blocks) {
  const rows = [];
  for (const block of blocks) {
    for (const row of block.rows || []) {
      const fields = fieldsOf(row);
      if (fields.length) rows.push(fields);
    }
  }
  return rows;
}

function matchedFields(text, fields) {
  const padded = ` ${norm(text)} `;
  if (padded === '  ') return [];
  const seen = new Set();
  const matched = [];
  for (const field of fields) {
    if (!padded.includes(` ${field.text} `)) continue;
    const id = `${field.key}:${field.text}`;
    if (seen.has(id)) continue;
    seen.add(id);
    matched.push(field);
  }
  return matched;
}

function leftover(text, matched) {
  let n = ` ${norm(text)} `;
  const unique = [...new Map(matched.map((f) => [f.text, f])).values()]
    .sort((a, b) => b.text.length - a.text.length);
  for (const field of unique) n = n.replaceAll(` ${field.text} `, ' ');
  return n.replace(/\s+/g, ' ').trim();
}

/** Identity plus at least one other field, and the line is mostly that row. One name is not enough. */
function isMaterialRow(text, rows) {
  if (!norm(text)) return false;
  for (const fields of rows) {
    const matched = matchedFields(text, fields);
    const extra = matched.filter((f) => f.key !== 'identity');
    const ident = matched.some((f) => f.key === 'identity');
    if (!ident || !extra.length) continue;
    const rest = leftover(text, matched);
    const longExtra = extra.some((f) => f.text.length >= 5);
    if (longExtra && rest.length <= 48) return true;
    if (extra.length >= 2 && rest.length <= 60) return true;
    if (rest.length <= 10) return true;
  }
  return false;
}

/** A line that is only a card's name or title, after labels and punctuation are folded. */
function isIdentityDump(text, rows) {
  if (!norm(text)) return false;
  for (const fields of rows) {
    const ident = matchedFields(text, fields).filter((f) => f.key === 'identity');
    if (!ident.length) continue;
    if (leftover(text, ident).length <= 8) return true;
  }
  return false;
}

function isTableLine(line) {
  const t = line.trim();
  return t.includes('|') && (t.startsWith('|') || t.split('|').length >= 3);
}

function isSeparatorLine(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line) {
  return line.split('|').map((c) => c.trim()).filter(Boolean).join(' ');
}

function matchesIdentity(text, rows) {
  return rows.some((fields) => matchedFields(text, fields).some((f) => f.key === 'identity'));
}

function tableIsDump(dataLines, rows) {
  if (!dataLines.length) return false;
  let material = 0;
  let identity = 0;
  for (const line of dataLines) {
    const cells = tableCells(line);
    if (isMaterialRow(cells, rows)) material += 1;
    else if (matchesIdentity(cells, rows)) identity += 1;
  }
  const dumps = material + identity;
  if (dumps < Math.ceil(dataLines.length * 0.6)) return false;
  return material >= 1 || identity >= 2;
}

function isListItem(line) {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);
}

function listBody(line) {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
}

function isPageLead(line) {
  const text = line.trim().replace(/\*\*/g, '').replace(/^#{1,3}\s+/, '');
  return /^page\s+\d+\s*$/i.test(text);
}

function proseWithoutDumps(line, rows) {
  const parts = line.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((part) => part.trim() && !isMaterialRow(part, rows));
  if (kept.length === parts.length) return line;
  return kept.join(' ').trim();
}

/**
 * Cards already show employee, project, task and job rows. Drop a paragraph,
 * bullet, numbered item, or markdown table only when it restates those rows
 * (same values after case, whitespace and punctuation folding; Status/Stage,
 * Assigned/Assignees and Due/Due date count as the same field). A sentence
 * that only mentions one name, or that explains the list, stays.
 * @param {string} reply
 * @param {Array<object>} blocks
 * @returns {string}
 */
export function suppressDuplicateRecordNarration(reply, blocks) {
  const lists = recordListBlocks(blocks);
  if (!lists.length || !reply) return reply || '';
  const rows = rowFields(lists);
  if (!rows.length) return reply;

  const lines = reply.split('\n');
  const drop = new Set();

  let i = 0;
  while (i < lines.length) {
    if (!(isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1]))) {
      i += 1;
      continue;
    }
    const start = i;
    i += 2;
    const data = [];
    while (i < lines.length && isTableLine(lines[i])) {
      data.push(lines[i]);
      i += 1;
    }
    const end = i;
    if (i < lines.length && lines[i].trim() === '') i += 1;
    if (tableIsDump(data, rows)) {
      for (let k = start; k < end; k += 1) drop.add(k);
      if (i > end) drop.add(end);
    }
  }

  i = 0;
  while (i < lines.length) {
    if (drop.has(i) || !isListItem(lines[i])) {
      i += 1;
      continue;
    }
    let j = i;
    const items = [];
    while (j < lines.length) {
      if (isListItem(lines[j])) {
        items.push(j);
        j += 1;
        continue;
      }
      if (lines[j].trim() === '' && j + 1 < lines.length && isListItem(lines[j + 1])) {
        j += 1;
        continue;
      }
      break;
    }
    const dumps = items.filter((idx) => {
      const body = listBody(lines[idx]);
      return isMaterialRow(body, rows) || isIdentityDump(body, rows);
    }).length;
    if (items.length >= 2 && dumps >= Math.ceil(items.length * 0.6)) {
      for (let k = i; k < j; k += 1) drop.add(k);
      for (let k = i - 1; k >= 0; k -= 1) {
        if (lines[k].trim() === '') {
          drop.add(k);
          continue;
        }
        if (isPageLead(lines[k])) drop.add(k);
        break;
      }
    }
    i = Math.max(j, i + 1);
  }

  i = 0;
  while (i < lines.length) {
    if (drop.has(i) || isListItem(lines[i]) || isTableLine(lines[i]) || !lines[i].trim()) {
      i += 1;
      continue;
    }
    if (isIdentityDump(lines[i], rows)) {
      let j = i + 1;
      while (j < lines.length && !drop.has(j) && lines[j].trim() && isIdentityDump(lines[j], rows)
        && !isListItem(lines[j]) && !isTableLine(lines[j])) j += 1;
      if (j - i >= 2) {
        for (let k = i; k < j; k += 1) drop.add(k);
      }
      i = Math.max(j, i + 1);
      continue;
    }
    const kept = proseWithoutDumps(lines[i], rows);
    if (!kept) drop.add(i);
    else if (kept !== lines[i]) lines[i] = kept;
    i += 1;
  }

  return lines.filter((_, idx) => !drop.has(idx)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

