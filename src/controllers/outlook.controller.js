import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import config from '../config/config.js';
import * as outlookClientService from '../services/outlookClient.service.js';

const listOutlookAccounts = catchAsync(async (req, res) => {
  const accounts = await outlookClientService.listOutlookAccounts(req.user.id);
  res.json(accounts);
});

const getMicrosoftAuthUrl = catchAsync(async (req, res) => {
  const url = await outlookClientService.getMicrosoftAuthUrl(req.user.id);
  res.json({ url });
});

const microsoftCallback = catchAsync(async (req, res) => {
  const { code, state } = req.query;
  let userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    userId = decoded.userId;
  } catch {
    return res.redirect(`${config.frontendBaseUrl}/communication/email?error=invalid_state`);
  }
  try {
    await outlookClientService.handleMicrosoftCallback(code, userId, state);
    return res.redirect(`${config.frontendBaseUrl}/communication/email?connected=outlook`);
  } catch (err) {
    const codeErr = err?.code;
    if (codeErr === 'MAILBOX_MISMATCH' || codeErr === 'POLICY_CHANGED' || codeErr === 'WRONG_PROVIDER') {
      return res.redirect(`${config.frontendBaseUrl}/communication/email?error=${encodeURIComponent(codeErr)}`);
    }
    return res.redirect(
      `${config.frontendBaseUrl}/communication/email?error=${encodeURIComponent(err.message || 'auth_failed')}`
    );
  }
});

const disconnectOutlookAccount = catchAsync(async (req, res) => {
  await outlookClientService.disconnectOutlookAccount(req.params.id, req.user.id);
  res.json({ success: true });
});

const listMessages = catchAsync(async (req, res) => {
  const { accountId, labelId, pageToken, pageSize, q } = req.query;
  const result = await outlookClientService.listMessages(accountId, req.user.id, {
    labelId,
    pageToken,
    pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    query: q || '',
  });
  res.json(result);
});

const listThreads = catchAsync(async (req, res) => {
  const { accountId, labelId, pageToken, pageSize, q } = req.query;
  const result = await outlookClientService.listThreads(accountId, req.user.id, {
    labelId,
    pageToken,
    pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    query: q || '',
  });
  res.json(result);
});

const getThread = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const thread = await outlookClientService.getThread(accountId, req.user.id, req.params.id);
  res.json(thread);
});

const getMessage = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const message = await outlookClientService.getMessage(accountId, req.user.id, req.params.id);
  res.json(message);
});

const getAttachment = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const { messageId, attachmentId } = req.params;
  const data = await outlookClientService.getAttachment(accountId, req.user.id, messageId, attachmentId);
  const buf = Buffer.from(data, 'base64');
  res.set('Content-Disposition', `attachment`);
  res.send(buf);
});

const sendMessage = catchAsync(async (req, res) => {
  const { accountId, to, cc, bcc, subject, html, attachments } = req.body;
  const result = await outlookClientService.sendMessage(accountId, req.user.id, {
    to,
    cc,
    bcc,
    subject,
    html,
    attachments: attachments || [],
  });
  res.status(httpStatus.CREATED).json(result);
});

const replyMessage = catchAsync(async (req, res) => {
  const { accountId, html, attachments } = req.body;
  const result = await outlookClientService.replyMessage(accountId, req.user.id, req.params.id, {
    html,
    attachments: attachments || [],
  });
  res.status(httpStatus.CREATED).json(result);
});

const replyAllMessage = catchAsync(async (req, res) => {
  const { accountId, html, attachments } = req.body;
  const result = await outlookClientService.replyAllMessage(accountId, req.user.id, req.params.id, {
    html,
    attachments: attachments || [],
  });
  res.status(httpStatus.CREATED).json(result);
});

const forwardMessage = catchAsync(async (req, res) => {
  const { accountId, to, html, attachments } = req.body;
  const result = await outlookClientService.forwardMessage(accountId, req.user.id, req.params.id, {
    to,
    html,
    attachments: attachments || [],
  });
  res.status(httpStatus.CREATED).json(result);
});

const modifyMessage = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const { addLabelIds, removeLabelIds } = req.body;
  await outlookClientService.modifyMessage(accountId, req.user.id, req.params.id, {
    addLabelIds: addLabelIds || [],
    removeLabelIds: removeLabelIds || [],
  });
  res.json({ success: true });
});

const batchModifyMessages = catchAsync(async (req, res) => {
  const { accountId } = req.body;
  const { messageIds, addLabelIds, removeLabelIds } = req.body;
  const result = await outlookClientService.batchModifyMessages(accountId, req.user.id, messageIds || [], {
    addLabelIds: addLabelIds || [],
    removeLabelIds: removeLabelIds || [],
  });
  res.json(result);
});

const batchModifyThreads = catchAsync(async (req, res) => {
  const { accountId, threadIds, addLabelIds, removeLabelIds } = req.body;
  const result = await outlookClientService.batchModifyThreads(accountId, req.user.id, threadIds || [], {
    addLabelIds: addLabelIds || [],
    removeLabelIds: removeLabelIds || [],
  });
  res.json(result);
});

const trashThreads = catchAsync(async (req, res) => {
  const { accountId, threadIds } = req.body;
  await outlookClientService.trashThreads(accountId, req.user.id, threadIds || []);
  res.json({ success: true });
});

const deleteMessage = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  await outlookClientService.deleteMessage(accountId, req.user.id, req.params.id);
  res.json({ success: true });
});

const listLabels = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const labels = await outlookClientService.listLabels(accountId, req.user.id);
  res.json(labels);
});

const createLabel = catchAsync(async (req, res) => {
  const { accountId } = req.query;
  const { name } = req.body;
  const label = await outlookClientService.createLabel(accountId, req.user.id, { name });
  res.status(httpStatus.CREATED).json(label);
});

export {
  listOutlookAccounts,
  getMicrosoftAuthUrl,
  microsoftCallback,
  disconnectOutlookAccount,
  listMessages,
  listThreads,
  getThread,
  getMessage,
  getAttachment,
  sendMessage,
  replyMessage,
  replyAllMessage,
  forwardMessage,
  modifyMessage,
  batchModifyMessages,
  batchModifyThreads,
  trashThreads,
  deleteMessage,
  listLabels,
  createLabel,
};
