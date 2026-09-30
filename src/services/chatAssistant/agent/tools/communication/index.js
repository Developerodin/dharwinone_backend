import searchMyMailbox from './searchMyMailbox.tool.js';
import searchChat from './searchChat.tool.js';
import listEmailActivity from './listEmailActivity.tool.js';

const instructions = [
  'Communication: the signed-in user\'s own email and chat messages, plus the platform email delivery log.',
  '- Emails in "my inbox / my mailbox / emails from X to me" → search_my_mailbox. It only reads the ' +
    'viewer\'s own connected Gmail / Outlook accounts; never search someone else\'s mailbox. Put plain ' +
    'words in query (no Gmail or Outlook operators) and a name or address in person.',
  '- "Summarise that email / thread" → search_my_mailbox again with the threadId and accountId from the ' +
    'earlier result, then summarise the returned messages yourself. connected false → tell the user to ' +
    'connect a mailbox in Communication → Email.',
  '- Chat messages ("did anyone mention X in chat", "what did Ravi say about Y") → search_chat. It only ' +
    'covers conversations the viewer is a member of. A group or person to narrow to goes in conversation.',
  '- partial / moreAvailable true → say the results may not be complete.',
  '- Emails the PLATFORM sent to someone ("was Priya\'s offer email delivered", "did the invite reach X", ' +
    '"which emails failed today") → list_email_activity with filters.person (name or address) and filters.type ' +
    '(e.g. "offer", "meetingInvitation", "resetPassword"). "sent" means the mail server accepted it — say inbox ' +
    'delivery and bounces are not tracked. A failed row\'s error is the reason. Never search_my_mailbox for this.',
].join('\n');

export default {
  domain: 'communication',
  summary: 'Your own mailbox threads and chat messages, plus the platform email delivery log (admins).',
  instructions,
  tools: [searchMyMailbox, searchChat, listEmailActivity],
};
