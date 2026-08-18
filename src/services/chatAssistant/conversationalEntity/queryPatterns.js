// Detect conversational lookups ("tell me about X") vs count/list queries.

import {
  detectBareDeicticReference,
  extractEntityAfterDeicticReference,
  isBareDeictic,
  PERSON_ENTITY_TYPES,
  resolveEntityNameWithContext,
  stripLeadingDeictic,
} from './deicticReference.js';

const COUNT_LIST_RE =
  /\b(how many|count|number of|total|list|show (?:me )?(?:all|every|each)|give me (?:all|every))\b/i;

const CONVERSATIONAL_RE =
  /\b(?:tell me (?:everything |more )?about|what do you know about|who is|who are|info on|information on|details (?:of|on|about)|show me details (?:of|on|about)|what about)\s+(.+)/i;

const EXPLICIT_ROLE_RE =
  /\b(?:tell me (?:everything |more )?about|what do you know about|info on|details (?:of|on|about)|what about)\s+(?:the\s+)?(.+?)\s+role\b/i;

/** Strip trailing punctuation / filler from an extracted subject. */
export function cleanSubject(raw) {
  const subject = stripLeadingDeictic(raw)
    .replace(/\?+$/, '')
    .replace(/\s+(please|thanks|thank you)\.?$/i, '')
    .trim();

  if (!subject || isBareDeictic(subject)) return '';
  return subject;
}

/**
 * @param {string} message
 * @param {{ name?: string|null, entitySubject?: object|null }} [context]
 * @returns {{ subject: string, intent: 'role'|'person', reference?: string|null, fromContext?: boolean } | { needsContext: true, reference?: string|null, intent: 'person' } | null}
 */
export function detectConversationalQuery(message, context = {}) {
  const text = String(message || '').trim();
  if (!text || COUNT_LIST_RE.test(text)) return null;

  const roleHit = text.match(EXPLICIT_ROLE_RE);
  if (roleHit) {
    const subject = cleanSubject(roleHit[1]);
    return subject ? { subject, intent: 'role' } : null;
  }

  const afterRef = extractEntityAfterDeicticReference(text, PERSON_ENTITY_TYPES);
  if (afterRef) {
    return {
      subject: afterRef.entityName,
      intent: 'person',
      reference: afterRef.reference,
    };
  }

  const bareRef = detectBareDeicticReference(text, PERSON_ENTITY_TYPES);
  if (bareRef) {
    const resolved = resolveEntityNameWithContext({
      reference: bareRef.reference,
      context,
    });
    if (resolved.needsContext) {
      return { needsContext: true, reference: resolved.reference, intent: 'person' };
    }
    return {
      subject: resolved.entityName,
      intent: 'person',
      reference: resolved.reference,
      fromContext: resolved.fromContext,
    };
  }

  const hit = text.match(CONVERSATIONAL_RE);
  if (!hit) return null;

  const subject = cleanSubject(hit[1]);
  return subject ? { subject, intent: 'person' } : null;
}
