/**
 * Socket.io auth attaches `socket.userId` (not `socket.data.userId`).
 * Use this when deciding whether a recipient is actively viewing a conversation room.
 *
 * Signal ownership (do not conflate with the frontend toast path):
 * - Backend bell/Notification persist skip → this module (socket room membership).
 * - Frontend in-app toast suppress → ChatSocketContext.activeConversationId only
 *   (set by joinConversation from the same selection that writes ?conv=).
 *
 * @param {object|null|undefined} socket
 * @param {string} uidStr
 * @returns {boolean}
 */
export function socketBelongsToUser(socket, uidStr) {
  if (!socket || uidStr == null || uidStr === '') return false;
  const want = String(uidStr);
  const fromRoot = socket.userId != null ? String(socket.userId) : '';
  if (fromRoot && fromRoot === want) return true;
  // Legacy / alternate adapters may still put id on data
  const fromData = socket.data?.userId != null ? String(socket.data.userId) : '';
  return Boolean(fromData && fromData === want);
}

/**
 * @param {import('socket.io').Server|null|undefined} io
 * @param {string} conversationId
 * @param {string} uidStr
 * @returns {boolean}
 */
export function isUserActiveInConversationRoom(io, conversationId, uidStr) {
  if (!io?.sockets || !conversationId || uidStr == null || uidStr === '') return false;
  const room = io.sockets.adapter?.rooms?.get(`conversation:${conversationId}`);
  if (!room) return false;
  for (const sid of room) {
    const sock = io.sockets.sockets.get(sid);
    if (socketBelongsToUser(sock, uidStr)) return true;
  }
  return false;
}
