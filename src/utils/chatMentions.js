import mongoose from 'mongoose';

const MAX_MENTIONS = 20;
const MAX_DISPLAY_NAME = 80;

export function participantUserId(p) {
  if (!p?.user) return '';
  if (typeof p.user === 'object') {
    return String(p.user._id ?? p.user.id ?? '');
  }
  return String(p.user);
}

function rawMentionUserId(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.userId) return String(item.userId);
  const user = item.user;
  if (!user) return '';
  if (typeof user === 'string') return user;
  if (typeof user === 'object') {
    return String(user._id ?? user.id ?? '');
  }
  return '';
}

/**
 * Keep only mentions of current group participants (not the sender).
 * Returns mongoose-ready `{ user, displayName }` rows.
 */
export function normalizeMentions(raw, conv, senderId) {
  if (!conv || conv.type !== 'group') return [];
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const participantIds = new Set((conv.participants || []).map(participantUserId).filter(Boolean));
  const sender = String(senderId || '');
  const seen = new Set();
  const out = [];

  for (const item of raw) {
    const userId = rawMentionUserId(item).trim();
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) continue;
    if (sender && userId === sender) continue;
    if (!participantIds.has(userId)) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);

    const fromItem = typeof item?.displayName === 'string' ? item.displayName : '';
    const fromUser = typeof item?.user?.name === 'string' ? item.user.name : '';
    const displayName = (fromItem || fromUser).trim().slice(0, MAX_DISPLAY_NAME);

    out.push({ user: userId, displayName });
    if (out.length >= MAX_MENTIONS) break;
  }

  return out;
}

export function formatMentionsForClient(mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return [];
  return mentions
    .map((m) => {
      const user = m?.user && typeof m.user === 'object' ? m.user : null;
      const userId = user
        ? String(user._id ?? user.id ?? '')
        : rawMentionUserId(m);
      if (!userId) return null;
      const name = (user?.name || m.displayName || '').trim();
      return {
        userId,
        displayName: (m.displayName || name).trim(),
        name,
        email: user?.email || '',
      };
    })
    .filter(Boolean);
}

export function mentionedUserIds(mentions) {
  return formatMentionsForClient(mentions).map((m) => m.userId);
}
