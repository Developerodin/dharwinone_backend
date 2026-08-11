import ConversationMemoryModel from '../../../models/conversationMemory.model.js';

export const PENDING_JOB_TTL_MS = 10 * 60 * 1000;
const PATH = 'lastEntities.pendingJobDisambiguation';

const INDEX_RE = /^\s*#?\s*(\d{1,2})\s*[.)]?\s*$/;
const ORDINAL_RE =
  /^\s*(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+(?:one|job|opening|position))?\s*[.!]?\s*$/i;

const WORD_INDEX = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5,
};

/**
 * @param {string} message
 * @param {{ matches?: object[] }} pending
 */
export function matchJobSelection(message, pending = {}) {
  const text = String(message || '').trim();
  const matches = pending.matches || [];
  if (!text || !matches.length) return { kind: 'unrelated' };

  const pick = (n) => {
    if (n < 1 || n > matches.length) return { kind: 'reask' };
    return { kind: 'select', jobId: matches[n - 1].jobId, title: matches[n - 1].title };
  };

  const idx = text.match(INDEX_RE);
  if (idx) return pick(Number(idx[1]));

  const ord = text.match(ORDINAL_RE);
  if (ord) return pick(WORD_INDEX[ord[1].toLowerCase()]);

  const lower = text.toLowerCase();
  const named = matches.filter((m) => lower.includes(String(m.title || '').toLowerCase()));
  if (named.length === 1) return { kind: 'select', jobId: named[0].jobId, title: named[0].title };

  return { kind: 'unrelated' };
}

export async function writePendingJob({
  userId,
  adminId,
  query,
  matches,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate(
    { userId, adminId },
    { $set: { [PATH]: { query, matches, createdAt: new Date() } } },
    { upsert: true },
  );
}

export async function readPendingJob({
  userId,
  adminId,
  now = Date.now(),
  ConversationMemory = ConversationMemoryModel,
}) {
  const doc = await ConversationMemory.findOne({ userId, adminId }).lean();
  const p = doc?.lastEntities?.pendingJobDisambiguation;
  if (!p?.createdAt || !p.matches?.length) return null;
  if (now - new Date(p.createdAt).getTime() > PENDING_JOB_TTL_MS) return null;
  return p;
}

export async function clearPendingJob({
  userId,
  adminId,
  ConversationMemory = ConversationMemoryModel,
}) {
  await ConversationMemory.findOneAndUpdate({ userId, adminId }, { $unset: { [PATH]: 1 } });
}
