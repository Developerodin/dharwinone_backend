/**
 * Shared receipt helpers for chat delivery / read tracking.
 * Supports legacy readBy ObjectId[] and newer { user, at } entries.
 */

export function receiptUserId(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (typeof entry === 'object') {
    if (entry.user != null) {
      if (typeof entry.user === 'object') {
        return String(entry.user._id || entry.user.id || '');
      }
      return String(entry.user);
    }
    if (entry.userId != null) return String(entry.userId);
    if (entry._id != null || entry.id != null) return String(entry._id || entry.id);
  }
  return null;
}

export function userHasReceipt(list, userId) {
  const uid = String(userId);
  return (list || []).some((entry) => receiptUserId(entry) === uid);
}

export function receiptAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const at = entry.at || entry.readAt || entry.deliveredAt;
  return at ? new Date(at).toISOString() : null;
}
