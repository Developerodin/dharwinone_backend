import crypto from 'crypto';
import { hashParticipantEmail } from './participantRoster.service.js';

const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

/**
 * UTC calendar day as YYYY-MM-DD.
 * @param {Date} [d]
 * @returns {string}
 */
export const dateBucketUtc = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/**
 * UTC midnight for a date.
 * @param {Date} d
 * @returns {Date}
 */
export const dayStartUtc = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

/**
 * Whole days between two instants (UTC date buckets).
 * @param {Date} a
 * @param {Date} b
 * @returns {number}
 */
export const daysBetweenUtc = (a, b) =>
  Math.round((dayStartUtc(a) - dayStartUtc(b)) / (24 * 60 * 60 * 1000));

/**
 * Whether a value is a 24-char hex ObjectId (rejects mock ids like "1").
 * @param {*} id
 * @returns {boolean}
 */
export const isObjectIdHex = (id) => OBJECT_ID_HEX_RE.test(String(id || '').trim());

/**
 * Copy-cache signature from facts. User id is intentionally excluded.
 * @param {{ situation: string, audience: string, days?: number, label?: string }} facts
 * @returns {string}
 */
export const copySignature = (facts) => {
  const payload = {
    situation: facts.situation,
    audience: facts.audience,
    days: facts.days ?? null,
    label: String(facts.label || '').trim().slice(0, 80),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
};

/**
 * True when the candidate appears on the roster with a join timestamp.
 * Empty roster or no matching firstJoinedAt = no-show.
 * @param {object} meeting
 * @returns {boolean}
 */
export const didCandidateJoin = (meeting) => {
  const roster = meeting?.participantRoster || [];
  if (!roster.length) return false;
  const email = meeting.candidate?.email;
  const candId = meeting.candidate?.id || meeting.candidateId;
  const hash = hashParticipantEmail(email);
  return roster.some((row) => {
    if (!row?.firstJoinedAt) return false;
    if (row.role === 'candidate') return true;
    if (hash && row.emailHash === hash) return true;
    if (candId && String(row.refId) === String(candId)) return true;
    return false;
  });
};

/**
 * Clamp generated copy to the contract limits.
 * @param {{ title?: string, message?: string }} copy
 * @returns {{ title: string, message: string }}
 */
export const clampCopy = (copy) => ({
  title: String(copy?.title || 'Reminder').trim().slice(0, 50),
  message: String(copy?.message || 'Please take action.').trim().slice(0, 140),
});

/**
 * Build a detector event. Skips when neither userId nor email is present.
 * @param {object} partial
 * @returns {object|null}
 */
export const buildEvent = (partial) => {
  const userId = partial.userId ? String(partial.userId) : '';
  const email = partial.email ? String(partial.email).trim().toLowerCase() : '';
  if (!userId && !email) return null;
  if (userId && !isObjectIdHex(userId)) return null;
  return {
    situation: partial.situation,
    audience: partial.audience,
    userId: userId || null,
    email: email || null,
    entityType: partial.entityType,
    entityId: String(partial.entityId),
    facts: {
      situation: partial.situation,
      audience: partial.audience,
      days: partial.days ?? null,
      label: String(partial.label || '').slice(0, 80),
    },
    link: partial.link,
    relatedEntity: partial.relatedEntity || { type: partial.entityType, id: String(partial.entityId) },
    metadata: partial.metadata || null,
    severity: partial.severity || 'medium',
    overlapTypes: partial.overlapTypes || [],
  };
};

/**
 * Deduplicate events by recipient + situation + entity.
 * @param {Array<object|null>} events
 * @returns {object[]}
 */
export const uniqueEvents = (events) => {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    if (!ev) continue;
    const who = ev.userId || ev.email;
    const key = `${who}|${ev.situation}|${ev.entityType}|${ev.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
};
