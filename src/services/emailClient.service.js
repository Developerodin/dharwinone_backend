import EmailAccount from '../models/emailAccount.model.js';
import * as gmailProvider from './emailProviders/gmailProvider.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

/**
 * Load account and ensure it belongs to the user.
 */
async function getAccountForUser(accountId, userId) {
  const account = await EmailAccount.findOne({ _id: accountId, user: userId });
  if (!account) throw new ApiError(httpStatus.NOT_FOUND, 'Email account not found');
  return account;
}

/**
 * Dispatch to the correct provider based on account.provider.
 */
export async function listAccounts(userId) {
  const accounts = await EmailAccount.find({ user: userId, status: 'active' })
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

export async function disconnectAccount(accountId, userId) {
  const account = await getAccountForUser(accountId, userId);
  account.status = 'revoked';
  await account.save();
  return { success: true };
}

export async function listMessages(accountId, userId, opts = {}) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.listMessages(account, opts);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function listThreads(accountId, userId, opts = {}) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.listThreads(account, opts);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function getThread(accountId, userId, threadId) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.getThread(account, threadId);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function getMessage(accountId, userId, messageId) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.getMessage(account, messageId);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function getAttachment(accountId, userId, messageId, attachmentId) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.getAttachment(account, messageId, attachmentId);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function sendMessage(accountId, userId, payload) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.sendMessage(account, payload);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function replyMessage(accountId, userId, messageId, payload) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.replyMessage(account, messageId, payload);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function forwardMessage(accountId, userId, messageId, payload) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') {
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
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function modifyMessage(accountId, userId, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.modifyMessage(account, messageId, { addLabelIds, removeLabelIds });
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function batchModifyMessages(accountId, userId, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!messageIds?.length) return { success: true, modified: 0 };
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.batchModifyMessages(account, messageIds, { addLabelIds, removeLabelIds });
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function batchModifyThreads(accountId, userId, threadIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!threadIds?.length) return { success: true, modified: 0 };
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.batchModifyThreads(account, threadIds, { addLabelIds, removeLabelIds });
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function trashThreads(accountId, userId, threadIds) {
  if (!threadIds?.length) return { success: true };
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.trashThreads(account, threadIds);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function deleteMessage(accountId, userId, messageId) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.deleteMessage(account, messageId);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function listLabels(accountId, userId) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.listLabels(account);
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}

export async function createLabel(accountId, userId, { name }) {
  const account = await getAccountForUser(accountId, userId);
  if (account.provider === 'gmail') return gmailProvider.createLabel(account, { name });
  throw new ApiError(httpStatus.BAD_REQUEST, 'Provider not yet supported');
}
