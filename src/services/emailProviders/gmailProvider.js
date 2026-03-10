import { google } from 'googleapis';
import config from '../../config/config.js';
import EmailAccount from '../../models/emailAccount.model.js';
import logger from '../../config/logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];

function createOAuth2Client() {
  const { clientId, clientSecret, redirectUri } = config.google;
  if (!clientId || !clientSecret) {
    throw new Error('GCP_GOOGLE_CLIENT_ID and GCP_GOOGLE_CLIENT_SECRET must be set for Gmail OAuth');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getGmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

/**
 * Build Google OAuth consent URL. State encodes userId for callback.
 */
export function getAuthUrl(userId) {
  const oauth2Client = createOAuth2Client();
  const state = Buffer.from(JSON.stringify({ userId: userId.toString() }), 'utf8').toString('base64url');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

/**
 * Exchange authorization code for tokens, create/update EmailAccount.
 */
export async function handleCallback(code, userId) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  const email = (data.email || '').toLowerCase();
  if (!email) throw new Error('Could not fetch user email from Google');

  const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  const existing = await EmailAccount.findOne({ user: userId, provider: 'gmail', email });
  if (existing) {
    existing.accessToken = tokens.access_token;
    existing.refreshToken = tokens.refresh_token || existing.refreshToken;
    existing.tokenExpiry = tokenExpiry;
    existing.status = 'active';
    await existing.save();
    return existing;
  }

  return EmailAccount.create({
    user: userId,
    provider: 'gmail',
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    tokenExpiry,
    status: 'active',
  });
}

/**
 * Refresh access token if expired.
 */
export async function refreshToken(account) {
  if (!account.refreshToken) throw new Error('No refresh token for this account');
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    refresh_token: account.refreshToken,
  });
  const { credentials } = await oauth2Client.refreshAccessToken();
  account.accessToken = credentials.access_token;
  if (credentials.expiry_date) account.tokenExpiry = new Date(credentials.expiry_date);
  await account.save();
  return account;
}

function isTokenExpired(account) {
  if (!account.tokenExpiry) return false;
  return Date.now() >= account.tokenExpiry.getTime() - 60000;
}

async function ensureValidToken(account) {
  if (isTokenExpired(account) && account.refreshToken) {
    await refreshToken(account);
  }
  return account;
}

/**
 * List messages in a label.
 * @param {Object} opts - labelId, pageToken (from prev response), pageSize, query
 */
export async function listMessages(account, { labelId, pageToken, pageSize = 20, query = '' } = {}) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const listParams = {
    userId: 'me',
    maxResults: Math.min(pageSize || 20, 100),
    pageToken: pageToken || undefined,
    q: query || undefined,
  };
  if (labelId) {
    listParams.labelIds = [labelId];
  }
  const res = await gmail.users.messages.list(listParams);

  const messages = res.data.messages || [];
  const items = await Promise.all(
    messages.map(async (m) => {
      const full = await gmail.users.messages.get({ userId: 'me', id: m.id });
      return formatMessageListItem(full.data);
    })
  );

  return {
    messages: items,
    nextPageToken: res.data.nextPageToken || null,
    resultSizeEstimate: res.data.resultSizeEstimate ?? items.length,
  };
}

/**
 * List threads (conversations) for Gmail-style threading.
 * @param {Object} opts - labelId, pageToken, pageSize, query
 */
export async function listThreads(account, { labelId, pageToken, pageSize = 20, query = '' } = {}) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const listParams = {
    userId: 'me',
    maxResults: Math.min(pageSize || 20, 100),
    pageToken: pageToken || undefined,
    q: query || undefined,
  };
  if (labelId) {
    listParams.labelIds = [labelId];
  }
  const listRes = await gmail.users.threads.list(listParams);
  const threads = listRes.data.threads || [];

  const items = await Promise.all(
    threads.map(async (t) => {
      const full = await gmail.users.threads.get({
        userId: 'me',
        id: t.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const msgs = full.data.messages || [];
      const headers = (h) => (h || []).reduce((acc, x) => {
        const k = (x.name || '').toLowerCase();
        if (k) acc[k] = x.value;
        return acc;
      }, {});
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      const firstH = first ? headers(first.payload?.headers) : {};
      const lastH = last ? headers(last.payload?.headers) : {};
      const labelIds = [...new Set(msgs.flatMap((m) => m.labelIds || []))];
      const isUnread = labelIds.includes('UNREAD');
      return {
        id: t.id,
        threadId: t.id,
        snippet: t.snippet || '',
        from: lastH.from || firstH.from || '',
        to: lastH.to || firstH.to || '',
        subject: firstH.subject || '(No subject)',
        date: lastH.date || firstH.date || null,
        messageCount: msgs.length,
        labelIds,
        isUnread,
      };
    })
  );

  return {
    threads: items,
    nextPageToken: listRes.data.nextPageToken || null,
    resultSizeEstimate: listRes.data.resultSizeEstimate ?? items.length,
  };
}

/**
 * Get full thread with all messages (for conversation view).
 */
export async function getThread(account, threadId) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });
  const thread = res.data;
  const msgs = thread.messages || [];

  const messages = await Promise.all(
    msgs.map((m) => {
      const fullMsg = m;
      const headers = (fullMsg.payload?.headers || []).reduce((acc, h) => {
        acc[(h.name || '').toLowerCase()] = h.value;
        return acc;
      }, {});

      let htmlBody = '';
      let textBody = '';
      const attachments = [];

      function processPart(part) {
        if (!part) return;
        const mimeType = (part.mimeType || 'text/plain').toLowerCase();
        const filename = part.filename || null;
        if (part.body?.attachmentId) {
          attachments.push({
            filename: filename || 'attachment',
            mimeType,
            size: part.body.size || 0,
            attachmentId: part.body.attachmentId,
            messageId: fullMsg.id,
          });
        } else if (part.body?.data) {
          const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
          if (filename) {
            attachments.push({
              filename,
              mimeType,
              size: part.body.size || 0,
              attachmentId: part.body.attachmentId,
              messageId: fullMsg.id,
            });
          } else if (mimeType === 'text/html') {
            htmlBody = decoded;
          } else if (mimeType === 'text/plain' && !textBody) {
            textBody = decoded;
          }
        }
        (part.parts || []).forEach(processPart);
      }
      processPart(fullMsg.payload);

      return {
        id: fullMsg.id,
        threadId: fullMsg.threadId,
        labelIds: fullMsg.labelIds || [],
        snippet: fullMsg.snippet || '',
        from: headers.from || '',
        to: headers.to || '',
        cc: headers.cc || '',
        subject: headers.subject || '',
        date: headers.date || null,
        messageId: headers['message-id'] || null,
        inReplyTo: headers['in-reply-to'] || null,
        references: headers.references || null,
        isUnread: (fullMsg.labelIds || []).includes('UNREAD'),
        htmlBody: htmlBody || null,
        textBody: textBody || null,
        attachments,
      };
    })
  );

  return { id: thread.id, messages };
}

function formatMessageListItem(msg) {
  const headers = (msg.payload?.headers || []).reduce((acc, h) => {
    acc[h.name?.toLowerCase()] = h.value;
    return acc;
  }, {});
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    snippet: msg.snippet || '',
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    date: headers.date || null,
    isUnread: (msg.labelIds || []).includes('UNREAD'),
  };
}

/**
 * Get full message with body and attachments.
 */
export async function getMessage(account, messageId) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const msg = res.data;

  const headers = (msg.payload?.headers || []).reduce((acc, h) => {
    acc[h.name?.toLowerCase()] = h.value;
    return acc;
  }, {});

  let htmlBody = '';
  let textBody = '';
  const attachments = [];

  function processPart(part, depth = 0) {
    if (!part) return;
    const mimeType = (part.mimeType || 'text/plain').toLowerCase();
    const filename = part.filename || null;

    if (part.body?.attachmentId) {
      attachments.push({
        filename: filename || 'attachment',
        mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
        messageId: msg.id,
      });
    } else if (part.body?.data) {
      const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (filename) {
        attachments.push({
          filename,
          mimeType,
          size: part.body.size || 0,
          attachmentId: part.body.attachmentId,
          messageId: msg.id,
        });
      } else if (mimeType === 'text/html') {
        htmlBody = decoded;
      } else if (mimeType === 'text/plain' && !textBody) {
        textBody = decoded;
      }
    }
    (part.parts || []).forEach((p) => processPart(p, depth + 1));
  }
  processPart(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    snippet: msg.snippet || '',
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    subject: headers.subject || '',
    date: headers.date || null,
    messageId: headers['message-id'] || null,
    inReplyTo: headers['in-reply-to'] || null,
    references: headers.references || null,
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    htmlBody: htmlBody || null,
    textBody: textBody || null,
    attachments,
  };
}

/**
 * Get attachment content (base64).
 */
export async function getAttachment(account, messageId, attachmentId) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return res.data.data;
}

/** Wrap a base64 string at 76 chars per line (RFC 2045). */
function wrapBase64(b64) {
  return b64.replace(/.{76}/g, '$&\r\n');
}

/** Unescape HTML entities so we send raw HTML, not &lt;p&gt;text&lt;/p&gt; */
function unescapeHtml(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Strip HTML tags for plain-text fallback. */
function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return '';
  return unescapeHtml(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build raw RFC 2822 message for sending.
 * Uses multipart/alternative (text/plain + text/html) so clients render HTML correctly.
 * Wraps in multipart/mixed only when attachments exist.
 */
function buildRawMessage({ from, to, cc, bcc, subject, html, attachments }) {
  const rawHtml = unescapeHtml(html || '<p></p>');
  const plainText = htmlToPlainText(rawHtml) || ' ';
  const htmlB64 = wrapBase64(Buffer.from(rawHtml, 'utf8').toString('base64'));
  const plainB64 = wrapBase64(Buffer.from(plainText, 'utf8').toString('base64'));

  const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const hasAttachments = attachments && attachments.length > 0;
  const mixBoundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const altPart = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    plainB64,
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
    `--${altBoundary}--`,
  ].join('\r\n');

  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
  ];
  if (cc) headers.push(`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`);
  if (bcc) headers.push(`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}`);
  headers.push(`Subject: ${subject || ''}`);
  headers.push('MIME-Version: 1.0');

  if (!hasAttachments) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    headers.push('');
    headers.push(altPart);
    return Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url');
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);
  headers.push('');
  headers.push(`--${mixBoundary}`);
  headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  headers.push('');
  headers.push(altPart);

  for (const att of attachments) {
    headers.push(`--${mixBoundary}`);
    headers.push(`Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename || 'attachment'}"`);
    headers.push('Content-Transfer-Encoding: base64');
    headers.push(`Content-Disposition: attachment; filename="${att.filename || 'attachment'}"`);
    headers.push('');
    const attB64 = typeof att.content === 'string' ? att.content : Buffer.from(att.content).toString('base64');
    headers.push(wrapBase64(attB64));
  }

  headers.push(`--${mixBoundary}--`);
  return Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url');
}

/**
 * Send a new email.
 */
export async function sendMessage(account, { to, cc, bcc, subject, html, attachments = [] } = {}) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const raw = buildRawMessage({
    from: account.email,
    to: Array.isArray(to) ? to : [to].filter(Boolean),
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
    subject: subject || '',
    html: html || '',
    attachments,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return { id: res.data.id, threadId: res.data.threadId };
}

/**
 * Reply to a message.
 */
export async function replyMessage(account, messageId, { html, attachments = [] } = {}) {
  const orig = await getMessage(account, messageId);
  const inReplyTo = orig.messageId || '';
  const references = orig.references ? `${orig.references} ${orig.messageId}`.trim() : (orig.messageId || '');
  const to = orig.from;
  const subject = (orig.subject || '').startsWith('Re:') ? orig.subject : `Re: ${orig.subject || ''}`;

  const rawHtml = unescapeHtml(html || '<p></p>');
  const plainText = htmlToPlainText(rawHtml) || ' ';
  const htmlB64 = wrapBase64(Buffer.from(rawHtml, 'utf8').toString('base64'));
  const plainB64 = wrapBase64(Buffer.from(plainText, 'utf8').toString('base64'));

  const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const hasAttachments = attachments && attachments.length > 0;
  const mixBoundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const altPart = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    plainB64,
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlB64,
    `--${altBoundary}--`,
  ].join('\r\n');

  const lines = [
    `From: ${account.email}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    'MIME-Version: 1.0',
  ];

  if (!hasAttachments) {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');
    lines.push(altPart);
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);
    lines.push('');
    lines.push(`--${mixBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push('');
    lines.push(altPart);
    for (const att of attachments) {
      lines.push(`--${mixBoundary}`);
      lines.push(`Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename || 'attachment'}"`);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push(`Content-Disposition: attachment; filename="${att.filename || 'attachment'}"`);
      lines.push('');
      const attB64 = typeof att.content === 'string' ? att.content : Buffer.from(att.content).toString('base64');
      lines.push(wrapBase64(attB64));
    }
    lines.push(`--${mixBoundary}--`);
  }

  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');

  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: orig.threadId,
    },
  });
  return { id: res.data.id, threadId: res.data.threadId };
}

/**
 * Modify message labels (star, archive, spam, mark read/unread).
 * @param {Object} opts - addLabelIds: string[], removeLabelIds: string[]
 */
export async function modifyMessage(account, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  const toAdd = Array.isArray(addLabelIds) ? addLabelIds.filter(Boolean) : [];
  const toRemove = Array.isArray(removeLabelIds) ? removeLabelIds.filter(Boolean) : [];
  if (toAdd.length === 0 && toRemove.length === 0) return { success: true };
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: toAdd.length ? toAdd : undefined,
      removeLabelIds: toRemove.length ? toRemove : undefined,
    },
  });
  return { success: true };
}

/**
 * Batch modify multiple messages.
 */
export async function batchModifyMessages(account, messageIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  await Promise.all(messageIds.map((id) => modifyMessage(account, id, { addLabelIds, removeLabelIds })));
  return { success: true, modified: messageIds.length };
}

/**
 * Batch modify all messages in the given threads.
 */
export async function batchModifyThreads(account, threadIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!threadIds?.length) return { success: true, modified: 0 };
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const allMessageIds = [];
  for (const tid of threadIds) {
    try {
      const res = await gmail.users.threads.get({ userId: 'me', id: tid, format: 'minimal' });
      const msgs = res.data.messages || [];
      allMessageIds.push(...msgs.map((m) => m.id));
    } catch {
      // skip failed thread
    }
  }
  if (allMessageIds.length === 0) return { success: true, modified: 0 };
  return batchModifyMessages(account, allMessageIds, { addLabelIds, removeLabelIds });
}

/**
 * Trash a message.
 */
export async function deleteMessage(account, messageId) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);
  await gmail.users.messages.trash({ userId: 'me', id: messageId });
  return { success: true };
}

/**
 * Trash all messages in the given threads.
 */
export async function trashThreads(account, threadIds) {
  if (!threadIds?.length) return { success: true };
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  for (const tid of threadIds) {
    try {
      const res = await gmail.users.threads.get({ userId: 'me', id: tid, format: 'minimal' });
      const msgs = res.data.messages || [];
      for (const m of msgs) {
        await gmail.users.messages.trash({ userId: 'me', id: m.id });
      }
    } catch {
      // skip
    }
  }
  return { success: true };
}

/**
 * List Gmail labels.
 */
export async function listLabels(account) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = (res.data.labels || []).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    messageListVisibility: l.messageListVisibility,
    labelListVisibility: l.labelListVisibility,
  }));
  return labels;
}

/**
 * Create a new Gmail label.
 * @param {string} name - Display name for the label
 * @returns {Object} Created label with id, name, type
 */
export async function createLabel(account, { name }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Label name is required');
  }
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);
  const res = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: name.trim(),
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
    },
  });
  const l = res.data;
  return {
    id: l.id,
    name: l.name,
    type: l.type,
    messageListVisibility: l.messageListVisibility,
    labelListVisibility: l.labelListVisibility,
  };
}
