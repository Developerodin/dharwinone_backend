/** Graph v1.0 mailFolder — wellKnownName exists only on /beta; use well-known path segments instead. */
export const GRAPH_MAIL_FOLDERS_LIST_URL =
  'https://graph.microsoft.com/v1.0/me/mailFolders?$top=200&$select=id,displayName,totalItemCount,unreadItemCount';

export const GRAPH_WELL_KNOWN_FOLDER_SELECT =
  'id,displayName,totalItemCount,unreadItemCount';

/**
 * Normalize a Graph mailFolder to the Gmail-compatible label shape used by the app.
 * @param {object} folder
 * @param {Map<string, string>} wellKnownIdToLabelId Graph folder id → INBOX|SENT|…
 */
export function normalizeOutlookFolder(folder, wellKnownIdToLabelId = new Map()) {
  const normalizedId = wellKnownIdToLabelId.get(folder.id);
  if (normalizedId) {
    return {
      id: normalizedId,
      name: folder.displayName || normalizedId,
      type: 'system',
      unread: Number(folder.unreadItemCount ?? 0) || 0,
      total: Number(folder.totalItemCount ?? 0) || 0,
    };
  }
  return {
    id: folder.id,
    name: folder.displayName || folder.id,
    type: 'user',
    unread: Number(folder.unreadItemCount ?? 0) || 0,
    total: Number(folder.totalItemCount ?? 0) || 0,
  };
}
