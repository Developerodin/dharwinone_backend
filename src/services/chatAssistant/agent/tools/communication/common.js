import * as gmailClient from '../../../../emailClient.service.js';
import * as outlookClient from '../../../../outlookClient.service.js';
import * as chatService from '../../../../chat.service.js';
import { queryEmailLogs as realQueryEmailLogs } from '../../../../email.service.js';
import { queryUsers as realQueryUsers } from '../../../../user.service.js';
import UserModel from '../../../../../models/user.model.js';
import {
  viewerSeesHiddenUsers as realViewerSeesHiddenUsers,
  getDirectoryHiddenUserIds as realGetDirectoryHiddenUserIds,
} from '../../../../../utils/platformAccess.util.js';
import { htmlToPlainText } from '../../../../../utils/htmlText.util.js';

// GET /v1/email/threads and /v1/outlook/threads (requirePermissions('emails.read')). The client
// services load the account with { _id: accountId, user: userId }, so only the caller's own
// connected mailboxes are ever read.
export const MAILBOX_ACCESS = Object.freeze({ anyOf: ['emails.read'] });
// chat.route.js: router.use(auth(), requirePermissions('chats.read')); searchMessages then runs
// chat.service ensureParticipant, so only conversations the caller is a member of are searched.
export const CHAT_ACCESS = Object.freeze({ anyOf: ['chats.read'] });
// EmailLog is the company-wide log of every platform email (no portal page reads it). Administrator by
// role name, or the Activity Logs delete tier — the tier that already sees every user's audit rows.
export const EMAIL_ACTIVITY_ACCESS = Object.freeze({ anyOf: ['activity.delete'], adminByName: true });

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/** Fail closed without a user id: every mailbox / chat call is keyed on it. */
export function communicationUserId(ctx) {
  const id = ctx?.user?.id ?? ctx?.user?._id;
  if (!id) throw new Error('communication tools need an authenticated user with an id');
  return String(id);
}

export function communicationDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    listGmailAccounts: deps.listGmailAccounts ?? gmailClient.listGmailAccounts,
    listOutlookAccounts: deps.listOutlookAccounts ?? outlookClient.listOutlookAccounts,
    listGmailThreads: deps.listGmailThreads ?? gmailClient.listThreads,
    listOutlookThreads: deps.listOutlookThreads ?? outlookClient.listThreads,
    getGmailThread: deps.getGmailThread ?? gmailClient.getThread,
    getOutlookThread: deps.getOutlookThread ?? outlookClient.getThread,
    listConversations: deps.listConversations ?? chatService.listConversations,
    searchMessages: deps.searchMessages ?? chatService.searchMessages,
    queryEmailLogs: deps.queryEmailLogs ?? realQueryEmailLogs,
    queryUsers: deps.queryUsers ?? realQueryUsers,
    User: deps.User ?? UserModel,
    viewerSeesHiddenUsers: deps.viewerSeesHiddenUsers ?? realViewerSeesHiddenUsers,
    getDirectoryHiddenUserIds: deps.getDirectoryHiddenUserIds ?? realGetDirectoryHiddenUserIds,
  };
}

export const bound = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A message body as plain text: the text part, else the HTML part stripped. */
export const plainBody = (m) => m?.textBody || (m?.htmlBody ? htmlToPlainText(m.htmlBody) : '');

/** Provider dates are RFC 2822 (Gmail header) or ISO (Graph); return ISO when parseable. */
export function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}
