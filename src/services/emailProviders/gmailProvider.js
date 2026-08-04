import httpStatus from 'http-status';
import { google } from 'googleapis';
import config from '../../config/config.js';
import EmailAccount from '../../models/emailAccount.model.js';
import { MAX_GMAIL_ACCOUNTS_PER_USER } from '../../constants/emailAccountLimits.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import {
  getAssignedMailboxPolicy,
  revokeAllOtherEmailAccounts,
} from '../emailConnectionPolicy.service.js';

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

/**
 * OAuth client for the account's refresh token. Refresh tokens are bound to the client_id
 * that minted them: tokens connected from the mobile app were issued by an installed-app
 * (Android/iOS) client that has NO secret, so they must be refreshed with that same client_id
 * and no secret. Web auth-code accounts fall back to the web client (id + secret).
 */
function refreshClientForAccount(account) {
  const id = (account.oauthClientId || '').trim();
  if (id) {
    const android = (config.googleApp?.androidClientId || '').trim();
    const ios = (config.googleApp?.iosClientId || '').trim();
    if (id === android || id === ios) {
      // Installed-app client: client_id only, no secret.
      return new google.auth.OAuth2(id);
    }
  }
  return createOAuth2Client();
}

function getGmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

async function revokeGoogleAccessToken(accessToken) {
  if (!accessToken) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }),
    });
  } catch (err) {
    logger.debug('[mailbox_lock] google token revoke failed: %s', err?.message);
  }
}

function parseOAuthState(stateEncoded) {
  if (!stateEncoded) return {};
  try {
    return JSON.parse(Buffer.from(stateEncoded, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Build Google OAuth consent URL. State encodes userId (+ policy fingerprint when mailbox lock applies).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ policy?: Awaited<ReturnType<typeof getAssignedMailboxPolicy>> }} [options]
 */
export function getAuthUrl(userId, options = {}) {
  const oauth2Client = createOAuth2Client();
  const stateObj = { userId: userId.toString() };
  const { policy } = options;
  if (policy?.hardLockActive && policy.policyFingerprint) {
    stateObj.policyFp = policy.policyFingerprint;
  }
  const state = Buffer.from(JSON.stringify(stateObj), 'utf8').toString('base64url');
  const urlOpts = {
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  };
  if (policy?.hardLockActive && policy.expectedEmail) {
    urlOpts.login_hint = policy.expectedEmail;
  }
  return oauth2Client.generateAuthUrl(urlOpts);
}

/**
 * Exchange authorization code for tokens, create/update EmailAccount.
 * @param {string} code
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string} [stateEncoded] raw state query param
 */
export async function handleCallback(code, userId, stateEncoded = '') {
  const stateObj = parseOAuthState(stateEncoded);
  const policy = await getAssignedMailboxPolicy(userId);

  if (policy.hardLockActive && stateObj.policyFp && stateObj.policyFp !== policy.policyFingerprint) {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    await revokeGoogleAccessToken(tokens.access_token);
    logger.warn('[mailbox_lock] mismatch_rejected reason=policy_changed userId=%s provider=gmail', String(userId));
    const err = new Error('POLICY_CHANGED');
    err.code = 'POLICY_CHANGED';
    throw err;
  }

  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  const email = (data.email || '').toLowerCase();
  if (!email) throw new Error('Could not fetch user email from Google');

  if (policy.hardLockActive) {
    if (email !== policy.expectedEmail) {
      await revokeGoogleAccessToken(tokens.access_token);
      logger.warn('[mailbox_lock] mismatch_rejected userId=%s provider=gmail', String(userId));
      const err = new Error('MAILBOX_MISMATCH');
      err.code = 'MAILBOX_MISMATCH';
      throw err;
    }
    if (!policy.allowedProviders.includes('gmail')) {
      await revokeGoogleAccessToken(tokens.access_token);
      const err = new Error('WRONG_PROVIDER');
      err.code = 'WRONG_PROVIDER';
      throw err;
    }
  }

  const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  return upsertGmailAccount(
    userId,
    {
      email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry,
      // Web auth-code flow uses the backend's (web) Google client.
      oauthClientId: (config.google.clientId || '').trim() || null,
    },
    policy
  );
}

/**
 * Create or update a Gmail EmailAccount and enforce mailbox-lock policy.
 * Shared by the web auth-code flow (handleCallback) and the mobile token flow (connectWithTokens).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ email: string, accessToken: string, refreshToken?: string|null, tokenExpiry?: Date|null, oauthClientId?: string|null }} fields
 * @param {Awaited<ReturnType<typeof getAssignedMailboxPolicy>>} policy
 */
async function upsertGmailAccount(
  userId,
  { email, accessToken, refreshToken, tokenExpiry = null, oauthClientId = null },
  policy
) {
  const existing = await EmailAccount.findOne({ user: userId, provider: 'gmail', email });
  if (existing) {
    existing.accessToken = accessToken;
    existing.refreshToken = refreshToken || existing.refreshToken;
    existing.tokenExpiry = tokenExpiry;
    existing.oauthClientId = oauthClientId || existing.oauthClientId;
    existing.status = 'active';
    await existing.save();
    if (policy.hardLockActive) {
      try {
        await revokeAllOtherEmailAccounts(userId, existing._id);
      } catch (revErr) {
        logger.error('[mailbox_lock] bulk_revoke_failed userId=%s %s', String(userId), revErr?.message);
      }
      logger.info('[mailbox_lock] enforced userId=%s provider=gmail', String(userId));
    }
    return existing;
  }

  const activeGmailCount = await EmailAccount.countDocuments({
    user: userId,
    provider: 'gmail',
    status: 'active',
  });
  const skipCap = policy.hardLockActive && email === policy.expectedEmail;
  if (!skipCap && activeGmailCount >= MAX_GMAIL_ACCOUNTS_PER_USER) {
    throw new Error(
      `Maximum of ${MAX_GMAIL_ACCOUNTS_PER_USER} Gmail accounts allowed. Disconnect one to add another.`
    );
  }

  const created = await EmailAccount.create({
    user: userId,
    provider: 'gmail',
    email,
    accessToken,
    refreshToken: refreshToken || null,
    tokenExpiry,
    oauthClientId: oauthClientId || null,
    status: 'active',
  });
  if (policy.hardLockActive) {
    try {
      await revokeAllOtherEmailAccounts(userId, created._id);
    } catch (revErr) {
      logger.error('[mailbox_lock] bulk_revoke_failed userId=%s %s', String(userId), revErr?.message);
    }
    logger.info('[mailbox_lock] enforced userId=%s provider=gmail', String(userId));
  }
  return created;
}

/**
 * Persist Gmail tokens from the mobile app (react-native-app-auth). Validates the access token
 * via Google userinfo. Installed-app clients have no secret; record the issuing client_id so
 * refresh reuses the matching client (see refreshClientForAccount).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ accessToken: string, refreshToken?: string|null, tokenExpiry?: Date|string|null }} tokens
 */
export async function connectWithTokens(userId, { accessToken, refreshToken, tokenExpiry }) {
  const policy = await getAssignedMailboxPolicy(userId);
  if (policy.hardLockActive && !policy.allowedProviders.includes('gmail')) {
    const err = new Error('WRONG_PROVIDER');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  let email = '';
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    email = (data.email || '').toLowerCase();
  } catch (err) {
    logger.error('[Gmail] connectWithTokens userinfo failed: %s', err?.message);
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid or expired Google access token.', true);
  }
  if (!email) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Could not fetch user email from Google.');
  }

  if (policy.hardLockActive) {
    if (email !== policy.expectedEmail) {
      await revokeGoogleAccessToken(accessToken);
      logger.warn('[mailbox_lock] mismatch_rejected userId=%s provider=gmail', String(userId));
      const err = new Error('MAILBOX_MISMATCH');
      err.code = 'MAILBOX_MISMATCH';
      throw err;
    }
    if (!policy.allowedProviders.includes('gmail')) {
      await revokeGoogleAccessToken(accessToken);
      const err = new Error('WRONG_PROVIDER');
      err.code = 'WRONG_PROVIDER';
      throw err;
    }
  }

  let expiry = null;
  if (tokenExpiry) {
    const parsed = tokenExpiry instanceof Date ? tokenExpiry : new Date(tokenExpiry);
    if (!Number.isNaN(parsed.getTime())) expiry = parsed;
  }

  // Tokens came from the mobile app; record the issuing client so refresh reuses the matching
  // client_id. iOS is gated off for now, so the Android client is the only configured one.
  const appClientId =
    (config.googleApp.androidClientId || '').trim() || (config.googleApp.iosClientId || '').trim() || null;

  return upsertGmailAccount(
    userId,
    { email, accessToken, refreshToken: refreshToken || null, tokenExpiry: expiry, oauthClientId: appClientId },
    policy
  );
}

/**
 * Refresh access token if expired.
 */
export async function refreshToken(account) {
  if (!account.refreshToken) throw new Error('No refresh token for this account');
  const oauth2Client = refreshClientForAccount(account);
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
 * Lightweight inbox check for the new-mail push poller. Returns inbound messages newer
 * than sinceDate (chronological), each as { id, from, subject, internalMs }.
 * Bounded to a small page and recent window to keep Gmail API quota low.
 * @param {Object} account EmailAccount
 * @param {Date|string|null} sinceDate
 */
export async function getNewInboxMessages(account, sinceDate) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
    labelIds: ['INBOX'],
    q: '-is:chat newer_than:2d',
  });
  const ids = (listRes.data.messages || []).map((m) => m.id);
  const sinceMs = sinceDate ? new Date(sinceDate).getTime() : 0;
  const out = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    const internalMs = Number(full.data.internalDate || 0);
    if (internalMs <= sinceMs) continue;
    const headers = (full.data.payload?.headers || []).reduce((acc, h) => {
      acc[(h.name || '').toLowerCase()] = h.value;
      return acc;
    }, {});
    out.push({ id, threadId: full.data.threadId || id, from: headers.from || '', subject: headers.subject || '(No subject)', internalMs });
  }
  return out.sort((a, b) => a.internalMs - b.internalMs);
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
        lastMessageId: last?.id,
        firstMessageId: first?.id,
        snippet: stripTags(t.snippet || ''),
        from: lastH.from || firstH.from || '',
        to: lastH.to || firstH.to || '',
        cc: lastH.cc || firstH.cc || '',
        bcc: lastH.bcc || firstH.bcc || '',
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

/** Normalize Gmail part mimeType (drop "; charset=..." etc.). */
function normalizeMimeType(mimeType) {
  return (mimeType || 'text/plain').split(';')[0].trim().toLowerCase();
}

function partHeaderMap(part) {
  return (part.headers || []).reduce((acc, h) => {
    acc[(h.name || '').toLowerCase()] = h.value || '';
    return acc;
  }, {});
}

function isHtmlMime(mimeType) {
  return mimeType === 'text/html' || mimeType === 'text/x-amp-html';
}

function isPlainMime(mimeType) {
  return mimeType === 'text/plain';
}

/**
 * True when this part should be treated as a downloadable file rather than the message body.
 * Large text/html|text/plain bodies often only have attachmentId and must NOT be skipped.
 */
function isFileAttachmentPart(part, mimeType) {
  const filename = (part.filename || '').trim();
  const disposition = (partHeaderMap(part)['content-disposition'] || '').toLowerCase();
  if (disposition.includes('attachment')) return true;
  if ((isHtmlMime(mimeType) || isPlainMime(mimeType)) && !disposition.includes('attachment')) {
    return false;
  }
  return Boolean(filename);
}

function decodePartData(data) {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Walk a Gmail message payload tree and collect bodies + attachments.
 * Body parts larger than ~2MB arrive as attachmentId only — those are listed in
 * pendingBodyFetches for the caller to resolve via users.messages.attachments.get.
 */
function extractBodiesFromPayload(payload, messageId) {
  let htmlBody = '';
  let textBody = '';
  let htmlDepth = Infinity;
  let textDepth = Infinity;
  const attachments = [];
  const pendingBodyFetches = [];

  function assignHtml(decoded, depth) {
    if (!decoded) return;
    // Prefer the outermost (shallowest) HTML part — nested message/rfc822 can overwrite otherwise.
    if (!htmlBody || depth < htmlDepth) {
      htmlBody = decoded;
      htmlDepth = depth;
    }
  }

  function assignText(decoded, depth) {
    if (!decoded) return;
    if (!textBody || depth < textDepth) {
      textBody = decoded;
      textDepth = depth;
    }
  }

  function processPart(part, depth = 0) {
    if (!part) return;
    const mimeType = normalizeMimeType(part.mimeType);
    const filename = (part.filename || '').trim();
    const asFile = isFileAttachmentPart(part, mimeType);

    if (isHtmlMime(mimeType) && !asFile) {
      if (part.body?.data) {
        assignHtml(decodePartData(part.body.data), depth);
      } else if (part.body?.attachmentId) {
        pendingBodyFetches.push({
          attachmentId: part.body.attachmentId,
          kind: 'html',
          depth,
        });
      }
    } else if (isPlainMime(mimeType) && !asFile) {
      if (part.body?.data) {
        assignText(decodePartData(part.body.data), depth);
      } else if (part.body?.attachmentId) {
        pendingBodyFetches.push({
          attachmentId: part.body.attachmentId,
          kind: 'plain',
          depth,
        });
      }
    } else if (part.body?.attachmentId && (asFile || filename || !mimeType.startsWith('multipart/'))) {
      // Skip pure multipart containers; keep real files and inline cid images.
      if (mimeType !== 'multipart/alternative' && mimeType !== 'multipart/related' && mimeType !== 'multipart/mixed') {
        attachments.push({
          filename: filename || 'attachment',
          mimeType,
          size: part.body.size || 0,
          attachmentId: part.body.attachmentId,
          messageId,
        });
      }
    } else if (part.body?.data && asFile && filename) {
      attachments.push({
        filename,
        mimeType,
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId || null,
        messageId,
      });
    }

    (part.parts || []).forEach((p) => processPart(p, depth + 1));
  }

  processPart(payload);
  return { htmlBody, textBody, attachments, pendingBodyFetches, htmlDepth, textDepth };
}

/** Fetch attachment-backed text/html|text/plain bodies from Gmail. */
async function resolvePendingBodyFetches(gmail, messageId, extracted) {
  let { htmlBody, textBody, htmlDepth, textDepth } = extracted;
  const pending = [...(extracted.pendingBodyFetches || [])].sort((a, b) => a.depth - b.depth);

  for (const item of pending) {
    if (item.kind === 'html' && htmlBody && item.depth >= htmlDepth) continue;
    if (item.kind === 'plain' && textBody && item.depth >= textDepth) continue;
    try {
      const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: item.attachmentId,
      });
      const decoded = decodePartData(res.data?.data);
      if (!decoded) continue;
      if (item.kind === 'html') {
        if (!htmlBody || item.depth < htmlDepth) {
          htmlBody = decoded;
          htmlDepth = item.depth;
        }
      } else if (item.kind === 'plain') {
        if (!textBody || item.depth < textDepth) {
          textBody = decoded;
          textDepth = item.depth;
        }
      }
    } catch (err) {
      logger.warn(`Failed to fetch Gmail body part ${item.attachmentId} for message ${messageId}: ${err.message}`);
    }
  }

  return { htmlBody, textBody };
}

function formatFullMessage(msg, bodies, { stripSnippet = false } = {}) {
  const headers = (msg.payload?.headers || []).reduce((acc, h) => {
    acc[(h.name || '').toLowerCase()] = h.value;
    return acc;
  }, {});

  let htmlBody = bodies.htmlBody || '';
  let textBody = bodies.textBody || '';
  // Mirror Outlook: if MIME walk found nothing, expose snippet so the app is never empty.
  if (!htmlBody && !textBody && (msg.snippet || '').trim()) {
    textBody = stripTags(msg.snippet.trim());
  }

  const rawSnippet = msg.snippet || '';
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    snippet: stripSnippet ? stripTags(rawSnippet) : rawSnippet,
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    bcc: headers.bcc || '',
    subject: headers.subject || '',
    date: headers.date || null,
    messageId: headers['message-id'] || null,
    inReplyTo: headers['in-reply-to'] || null,
    references: headers.references || null,
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    htmlBody: htmlBody || null,
    textBody: textBody || null,
    attachments: bodies.attachments || [],
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
    msgs.map(async (fullMsg) => {
      const extracted = extractBodiesFromPayload(fullMsg.payload, fullMsg.id);
      const resolved = await resolvePendingBodyFetches(gmail, fullMsg.id, extracted);
      return formatFullMessage(fullMsg, {
        htmlBody: resolved.htmlBody,
        textBody: resolved.textBody,
        attachments: extracted.attachments,
      });
    }),
  );

  const labelIds = [...new Set(messages.flatMap((m) => m.labelIds || []))];
  return { id: thread.id, messages, labelIds };
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

  const extracted = extractBodiesFromPayload(msg.payload, msg.id);
  const resolved = await resolvePendingBodyFetches(gmail, msg.id, extracted);
  return formatFullMessage(
    msg,
    {
      htmlBody: resolved.htmlBody,
      textBody: resolved.textBody,
      attachments: extracted.attachments,
    },
    { stripSnippet: true },
  );
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

function stripTags(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>?/gm, '')
    .replace(/&lt;[^&]*&gt;/gm, '')
    .replace(/&[a-z0-9#]+;/gi, ' ');
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
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>?/gm, '')           // Strip actual tags
    .replace(/&lt;[^&]*&gt;/gm, '')      // Strip encoded tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')      // Other entities
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
  ];
  const toValue = Array.isArray(to) ? to.filter(Boolean).join(', ') : to;
  if (toValue) headers.push(`To: ${toValue}`);
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
 * Create a Gmail draft (synced across devices).
 */
export async function createDraft(account, { to, cc, bcc, subject, html, attachments = [] } = {}) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const toList = Array.isArray(to) ? to : [to].filter(Boolean);
  const raw = buildRawMessage({
    from: account.email,
    to: toList,
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
    subject: subject || '',
    html: html || '',
    attachments,
  });

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  return {
    id: res.data.id,
    draftId: res.data.id,
    messageId: res.data.message?.id || null,
    threadId: res.data.message?.threadId || null,
  };
}

/**
 * Update an existing Gmail draft. `draftId` may be a draft resource id or a message id.
 */
export async function updateDraft(account, draftId, { to, cc, bcc, subject, html, attachments = [] } = {}) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  let resolvedDraftId = draftId;
  try {
    await gmail.users.drafts.get({ userId: 'me', id: draftId });
  } catch {
    const list = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 });
    const match = (list.data.drafts || []).find((d) => d.message?.id === draftId);
    if (!match?.id) {
      throw new Error('Draft not found');
    }
    resolvedDraftId = match.id;
  }

  const toList = Array.isArray(to) ? to : [to].filter(Boolean);
  const raw = buildRawMessage({
    from: account.email,
    to: toList,
    cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
    subject: subject || '',
    html: html || '',
    attachments,
  });

  const res = await gmail.users.drafts.update({
    userId: 'me',
    id: resolvedDraftId,
    requestBody: { id: resolvedDraftId, message: { raw } },
  });

  return {
    id: res.data.id,
    draftId: res.data.id,
    messageId: res.data.message?.id || null,
    threadId: res.data.message?.threadId || null,
  };
}

function extractEmailAddr(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function splitAddressHeader(header) {
  if (!header || !String(header).trim()) return [];
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(header)) {
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Build To / Cc lines for Reply All (exclude mailbox owner). */
function buildReplyAllToCc(orig, selfEmail) {
  const self = extractEmailAddr(selfEmail);
  const fromParts = splitAddressHeader(orig.from);
  const toParts = splitAddressHeader(orig.to);
  const ccParts = splitAddressHeader(orig.cc || '');
  const toSet = new Set();
  const toOut = [];
  const addTo = (raw) => {
    const e = extractEmailAddr(raw);
    if (!e || e === self) return;
    if (toSet.has(e)) return;
    toSet.add(e);
    toOut.push(raw.trim());
  };
  for (const p of fromParts) addTo(p);
  for (const p of toParts) addTo(p);
  const ccOut = [];
  const ccSeen = new Set();
  for (const p of ccParts) {
    const e = extractEmailAddr(p);
    if (!e || e === self) continue;
    if (toSet.has(e)) continue;
    if (ccSeen.has(e)) continue;
    ccSeen.add(e);
    ccOut.push(p.trim());
  }
  return { to: toOut.join(', '), cc: ccOut.join(', ') };
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
 * Reply all — same thread as original; To/Cc from message headers minus self.
 */
export async function replyAllMessage(account, messageId, { html, attachments = [] } = {}) {
  const orig = await getMessage(account, messageId);
  const { to, cc } = buildReplyAllToCc(orig, account.email);
  if (!to) {
    return replyMessage(account, messageId, { html, attachments });
  }
  const inReplyTo = orig.messageId || '';
  const references = orig.references ? `${orig.references} ${orig.messageId}`.trim() : (orig.messageId || '');
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
    ...(cc ? [`Cc: ${cc}`] : []),
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
 * Authoritative folder counts from Gmail `users.labels.get`.
 * Uses threadsUnread/threadsTotal to match conversation (thread) view parity with Gmail.
 *
 * `users.labels.list` does not include counts — each label must be fetched individually.
 */
const GMAIL_FOLDER_LABELS = {
  inbox: 'INBOX',
  sent: 'SENT',
  draft: 'DRAFT',
  spam: 'SPAM',
  trash: 'TRASH',
  important: 'IMPORTANT',
  starred: 'STARRED',
};

export async function getFolderCounts(account) {
  await ensureValidToken(account);
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ access_token: account.accessToken });
  const gmail = getGmailClient(oauth2Client);

  const entries = await Promise.all(
    Object.entries(GMAIL_FOLDER_LABELS).map(async ([folder, labelId]) => {
      try {
        const res = await gmail.users.labels.get({ userId: 'me', id: labelId });
        const data = res.data || {};
        return [
          folder,
          {
            unread: Number(data.threadsUnread ?? data.messagesUnread ?? 0) || 0,
            total: Number(data.threadsTotal ?? data.messagesTotal ?? 0) || 0,
            messagesUnread: Number(data.messagesUnread ?? 0) || 0,
            messagesTotal: Number(data.messagesTotal ?? 0) || 0,
          },
        ];
      } catch (err) {
        logger.warn('[Gmail] labels.get %s failed: %s', labelId, err?.message || err);
        return [folder, { unread: 0, total: 0, messagesUnread: 0, messagesTotal: 0 }];
      }
    })
  );

  return Object.fromEntries(entries);
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
