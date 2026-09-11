/**
 * Title/body for chat message notifications (in-app + FCM).
 * Groups use the group name as the title (and again in the body) so a
 * collapsed/killed-app tray still shows this is a group, not a DM.
 */
export function buildChatNotifyCopy({
  isGroup,
  groupName,
  senderName,
  preview,
  isMentioned,
}) {
  const sender = String(senderName || '').trim() || 'Someone';
  const text = String(preview || '').trim().slice(0, 120) || 'New message';
  if (isGroup) {
    const group = String(groupName || '').trim() || 'Group';
    return {
      title: group,
      subtitle: sender,
      message: isMentioned
        ? `${sender} mentioned you in ${group}: ${text}`
        : `${sender} in ${group}: ${text}`,
    };
  }
  return {
    title: sender,
    message: isMentioned ? `${sender} mentioned you: ${text}` : text,
  };
}
