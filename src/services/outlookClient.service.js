import EmailAccount from '../models/emailAccount.model.js';
import * as outlookProvider from './emailProviders/outlookProvider.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

async function getOutlookAccountForUser(accountId, userId) {
  const account = await EmailAccount.findOne({ _id: accountId, user: userId });
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, 'Email account not found');
  if (account.provider !== 'outlook') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Account is not an Outlook account; use the email API for Gmail.');
  }
  return account;
}

export async function listOutlookAccounts(userId) {
  const accounts = await EmailAccount.find({ user: userId, status: 'active', provider: 'outlook' })
    .select('provider email status createdAt')
    .lean();
  return accounts.map((a) => ({ id: a._id.toString(), ...a }));
}

export async function getMicrosoftAuthUrl(userId) {
  return outlookProvider.getAuthUrl(userId);
}

export async function handleMicrosoftCallback(code, userId) {
  return outlookProvider.handleCallback(code, userId);
}

export async function disconnectOutlookAccount(accountId, userId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  account.status = 'revoked';
  await account.save();
  return { success: true };
}

export async function listMessages(accountId, userId, opts = {}) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.listMessages(account, opts);
}

export async function listThreads(accountId, userId, opts = {}) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.listThreads(account, opts);
}

export async function getThread(accountId, userId, threadId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.getThread(account, threadId);
}

export async function getMessage(accountId, userId, messageId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.getMessage(account, messageId);
}

export async function getAttachment(accountId, userId, messageId, attachmentId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.getAttachment(account, messageId, attachmentId);
}

export async function sendMessage(accountId, userId, payload) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.sendMessage(account, payload);
}

export async function replyMessage(accountId, userId, messageId, payload) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.replyMessage(account, messageId, payload);
}

export async function forwardMessage(accountId, userId, messageId, payload) {
  const account = await getOutlookAccountForUser(accountId, userId);
  const orig = await outlookProvider.getMessage(account, messageId);
  const fwdSubject = (orig.subject || '').startsWith('Fwd:') ? orig.subject : `Fwd: ${orig.subject || ''}`;
  const fwdBody = [
    '---------- Forwarded message ---------',
    `From: ${orig.from}`,
    `Date: ${orig.date}`,
    `Subject: ${orig.subject}`,
    `To: ${orig.to}`,
    '',
    orig.htmlBody || orig.textBody || '',
    '',
    payload.html || '',
  ].join('\n');
  return outlookProvider.sendMessage(account, {
    to: payload.to,
    subject: fwdSubject,
    html: fwdBody,
    attachments: payload.attachments || [],
  });
}

export async function modifyMessage(accountId, userId, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.modifyMessage(account, messageId, { addLabelIds, removeLabelIds });
}

export async function batchModifyMessages(accountId, userId, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!messageIds?.length) return { success: true, modified: 0 };
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.batchModifyMessages(account, messageIds, { addLabelIds, removeLabelIds });
}

export async function batchModifyThreads(accountId, userId, threadIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!threadIds?.length) return { success: true, modified: 0 };
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.batchModifyThreads(account, threadIds, { addLabelIds, removeLabelIds });
}

export async function trashThreads(accountId, userId, threadIds) {
  if (!threadIds?.length) return { success: true };
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.trashThreads(account, threadIds);
}

export async function deleteMessage(accountId, userId, messageId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.deleteMessage(account, messageId);
}

export async function listLabels(accountId, userId) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.listLabels(account);
}

export async function createLabel(accountId, userId, { name }) {
  const account = await getOutlookAccountForUser(accountId, userId);
  return outlookProvider.createLabel(account, { name });
}
