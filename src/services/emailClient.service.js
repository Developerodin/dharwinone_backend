import EmailAccount from '../models/emailAccount.model.js';
import * as gmailProvider from './emailProviders/gmailProvider.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

async function getGmailAccountForUser(accountId, userId) {
  const account = await EmailAccount.findOne({ _id: accountId, user: userId });
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, 'Email account not found');
  if (account.provider !== 'gmail') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Account is not a Gmail account; use the Outlook API for Microsoft mail.');
  }
  return account;
}

/** Active Gmail accounts only (Outlook lives under /v1/outlook). */
export async function listGmailAccounts(userId) {
  const accounts = await EmailAccount.find({ user: userId, status: 'active', provider: 'gmail' })
    .select('provider email status createdAt')
    .lean();
  return accounts.map((a) => ({ id: a._id.toString(), ...a }));
}

export async function getGoogleAuthUrl(userId) {
  return gmailProvider.getAuthUrl(userId);
}

export async function handleGoogleCallback(code, userId) {
  return gmailProvider.handleCallback(code, userId);
}

export async function disconnectGmailAccount(accountId, userId) {
  const account = await getGmailAccountForUser(accountId, userId);
  account.status = 'revoked';
  await account.save();
  return { success: true };
}

export async function listMessages(accountId, userId, opts = {}) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.listMessages(account, opts);
}

export async function listThreads(accountId, userId, opts = {}) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.listThreads(account, opts);
}

export async function getThread(accountId, userId, threadId) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.getThread(account, threadId);
}

export async function getMessage(accountId, userId, messageId) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.getMessage(account, messageId);
}

export async function getAttachment(accountId, userId, messageId, attachmentId) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.getAttachment(account, messageId, attachmentId);
}

export async function sendMessage(accountId, userId, payload) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.sendMessage(account, payload);
}

export async function replyMessage(accountId, userId, messageId, payload) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.replyMessage(account, messageId, payload);
}

export async function forwardMessage(accountId, userId, messageId, payload) {
  const account = await getGmailAccountForUser(accountId, userId);
  const orig = await gmailProvider.getMessage(account, messageId);
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
  return gmailProvider.sendMessage(account, {
    to: payload.to,
    subject: fwdSubject,
    html: fwdBody,
    attachments: payload.attachments || [],
  });
}

export async function modifyMessage(accountId, userId, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.modifyMessage(account, messageId, { addLabelIds, removeLabelIds });
}

export async function batchModifyMessages(accountId, userId, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!messageIds?.length) return { success: true, modified: 0 };
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.batchModifyMessages(account, messageIds, { addLabelIds, removeLabelIds });
}

export async function batchModifyThreads(accountId, userId, threadIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!threadIds?.length) return { success: true, modified: 0 };
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.batchModifyThreads(account, threadIds, { addLabelIds, removeLabelIds });
}

export async function trashThreads(accountId, userId, threadIds) {
  if (!threadIds?.length) return { success: true };
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.trashThreads(account, threadIds);
}

export async function deleteMessage(accountId, userId, messageId) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.deleteMessage(account, messageId);
}

export async function listLabels(accountId, userId) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.listLabels(account);
}

export async function createLabel(accountId, userId, { name }) {
  const account = await getGmailAccountForUser(accountId, userId);
  return gmailProvider.createLabel(account, { name });
}
