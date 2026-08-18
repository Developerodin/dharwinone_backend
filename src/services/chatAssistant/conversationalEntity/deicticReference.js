/** Deictic words that are never valid entity search terms on their own. */
export const BARE_DEICTIC_RE = /^(?:this|that|the)$/i;

/** Conversational opener fragment shared by job/person reference extractors. */
export const CONVERSATIONAL_OPENER =
  '(?:tell me (?:everything |more )?about|what(?:\'s| is)|what about|info on|information on|details (?:of|on|about))';

const JOB_ENTITY_TYPES = ['job', 'opening', 'position', 'posting', 'vacancy', 'role'];
const PERSON_ENTITY_TYPES = ['employee', 'agent', 'person', 'candidate', 'student', 'mentor'];

/** Strip leading deictic prefix from a captured phrase. */
export function stripLeadingDeictic(raw) {
  return String(raw || '')
    .replace(/^(?:this|that|the)(?:\s+|$)/i, '')
    .trim();
}

/** True when the term is only a bare deictic with no entity name. */
export function isBareDeictic(term) {
  return BARE_DEICTIC_RE.test(String(term || '').trim());
}

function entityTypesPattern(types) {
  return types.join('|');
}

function referencePattern(types) {
  return new RegExp(`\\b(?:this|that)\\s+(?:${entityTypesPattern(types)})\\b`, 'i');
}

/**
 * Extract explicit entity name immediately after a deictic + entity-type reference.
 * e.g. "this job Software Application Developer" → "Software Application Developer"
 *
 * @param {string} message
 * @param {string[]} [entityTypes]
 * @returns {{ entityName: string, reference: string } | null}
 */
export function extractEntityAfterDeicticReference(message, entityTypes = JOB_ENTITY_TYPES) {
  const types = entityTypesPattern(entityTypes);
  const re = new RegExp(
    `\\b${CONVERSATIONAL_OPENER}\\s+(?:the\\s+)?(?:this|that)\\s+(?:${types})\\s+(.+?)\\.?$`,
    'i',
  );
  const hit = String(message || '').trim().match(re);
  if (!hit) return null;

  const entityName = stripLeadingDeictic(hit[1])
    .replace(/\?+$/, '')
    .trim();
  if (!entityName || isBareDeictic(entityName)) return null;

  const refMatch = String(message || '').match(referencePattern(entityTypes));
  return {
    entityName,
    reference: refMatch ? refMatch[0].toLowerCase() : 'this',
  };
}

/**
 * Detect bare deictic reference with no explicit entity name in the message.
 * e.g. "tell me about this job" or "what about this job?"
 *
 * @param {string} message
 * @param {string[]} [entityTypes]
 * @returns {{ reference: string } | null}
 */
export function detectBareDeicticReference(message, entityTypes = JOB_ENTITY_TYPES) {
  const types = entityTypesPattern(entityTypes);
  const re = new RegExp(
    `\\b${CONVERSATIONAL_OPENER}\\s+(?:the\\s+)?(?:this|that)\\s+(?:${types})\\s*[.?!]?\\s*$`,
    'i',
  );
  const text = String(message || '').trim();
  if (!re.test(text)) return null;

  const refMatch = text.match(referencePattern(entityTypes));
  return { reference: refMatch ? refMatch[0].toLowerCase() : 'this' };
}

/**
 * Resolve an entity name using explicit text first, then conversation context.
 *
 * @param {{ entityName?: string|null, reference?: string|null, context?: object }} input
 * @returns {{ entityName: string|null, reference: string|null, fromContext?: boolean, needsContext?: boolean }}
 */
export function resolveEntityNameWithContext({ entityName = null, reference = null, context = {} }) {
  const cleaned = entityName ? stripLeadingDeictic(entityName) : '';
  if (cleaned && !isBareDeictic(cleaned)) {
    return { entityName: cleaned, reference, fromContext: false };
  }

  const ctxName =
    context.name ??
    context.jobTitle ??
    context.designation ??
    context.entitySubject?.name ??
    null;

  if (ctxName) {
    return { entityName: String(ctxName).trim(), reference, fromContext: true };
  }

  return { entityName: null, reference, needsContext: true };
}

export { JOB_ENTITY_TYPES, PERSON_ENTITY_TYPES };
