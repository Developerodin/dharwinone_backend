const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntitiesOnce(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code >= 0x110000) return entity;
      try {
        return String.fromCodePoint(code);
      } catch {
        return entity;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function decodeEntities(value) {
  let s = value;
  for (let i = 0; i < 2; i += 1) {
    const next = decodeEntitiesOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

function stripDangerous(value) {
  let cur = value;
  let prev;
  do {
    prev = cur;
    cur = cur.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    cur = cur.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  } while (cur !== prev);
  return cur
    .replace(/<script\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, '');
}

function numberOrderedLists(value) {
  return value.replace(/<ol\b[^>]*>[\s\S]*?<\/ol>/gi, (block) => {
    let n = 0;
    return block.replace(/<li\b[^>]*>/gi, () => {
      n += 1;
      return `\n${n}. `;
    });
  });
}

function toReadableMarkup(value) {
  let s = stripDangerous(value);
  s = numberOrderedLists(s);
  s = s.replace(/<h([1-3])\b[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `);
  s = s.replace(/<h([4-6])\b[^>]*>/gi, '\n#### ');
  s = s.replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<(strong|b)\b[^>]*>/gi, '**');
  s = s.replace(/<\/(strong|b)>/gi, '**');
  s = s.replace(/<(em|i)\b[^>]*>/gi, '*');
  s = s.replace(/<\/(em|i)>/gi, '*');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<p\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(div|tr|ul|ol|blockquote|section|table)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  return s;
}

function tidy(value) {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Job descriptions are stored as HTML. Headings, lists, paragraphs and line
 * breaks become readable text. Script, style and every other tag are removed
 * before the text reaches the model or a card. Empty and already-plain text
 * pass through. Malformed markup does not throw.
 * mapJobRow and the job card renderer both call this, so a description is
 * plain on every job path that shows or sends it.
 * @param {unknown} value
 * @returns {string}
 */
export function htmlToReadable(value) {
  try {
    const raw = String(value ?? '');
    if (!raw.trim()) return '';
    if (!/[<&]/.test(raw)) return raw.trim();
    let s = tidy(decodeEntities(toReadableMarkup(raw)));
    if (/<[^>]+>/.test(s) || /<script\b/i.test(s) || /<style\b/i.test(s)) {
      s = tidy(decodeEntities(toReadableMarkup(s)));
    }
    return s;
  } catch {
    return '';
  }
}
