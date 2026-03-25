import * as msal from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import httpStatus from 'http-status';
import config from '../../config/config.js';
import EmailAccount from '../../models/emailAccount.model.js';
import logger from '../../config/logger.js';
import { MAX_OUTLOOK_ACCOUNTS_PER_USER } from '../../constants/emailAccountLimits.js';
import ApiError from '../../utils/ApiError.js';

const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.ReadWrite',
  'Mail.Send',
  'User.Read',
];

/** Space-separated scopes for POST /oauth2/v2.0/token refresh_token grant */
const REFRESH_TOKEN_SCOPE =
  'openid profile email offline_access Mail.ReadWrite Mail.Send User.Read';
const REFRESH_TOKEN_SCOPE_FALLBACK = 'offline_access Mail.ReadWrite Mail.Send User.Read';

const FOLDER_MAP = {
  INBOX: 'inbox',
  SENT: 'sentitems',
  TRASH: 'deleteditems',
  DRAFT: 'drafts',
  JUNK: 'junkemail',
  ARCHIVE: 'archive',
  OUTBOX: 'outbox',
};

// Maps Outlook well-known folder names → normalized IDs used by the frontend
const REVERSE_FOLDER_MAP = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  deleteditems: 'TRASH',
  drafts: 'DRAFT',
  junkemail: 'JUNK',
  archive: 'ARCHIVE',
  outbox: 'OUTBOX',
};

function createMsalApp() {
  const { clientId, clientSecret, tenantId } = config.microsoft;
  if (!clientId || !clientSecret) {
    throw new Error('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set for Outlook OAuth');
  }
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId || 'common'}`,
    },
  });
}

/**
 * MSAL does not put refresh_token on AuthenticationResult for auth-code flow — it only
 * lands in the token cache. We must persist that secret for long-lived Outlook access.
 */
function extractRefreshTokenFromMsalCache(msalApp) {
  try {
    const parsed = JSON.parse(msalApp.getTokenCache().serialize());
    const rtMap = parsed.RefreshToken || {};
    for (const key of Object.keys(rtMap)) {
      const secret = rtMap[key]?.secret;
      if (secret && typeof secret === 'string') {
        return secret;
      }
    }
  } catch (err) {
    logger.warn('[Outlook] MSAL cache read failed: %s', err.message);
  }
  return null;
}

function createGraphClient(accessToken) {
  const t = (accessToken || '').trim();
  if (!t) {
    throw new Error('Microsoft Graph access token is empty; reconnect Outlook.');
  }
  return Client.init({
    authProvider: (done) => done(null, t),
  });
}

/**
 * Only well-known + real Graph folder IDs. Gmail label IDs must not be used as folder paths.
 */
function resolveOutlookFolderId(labelId) {
  if (!labelId || labelId === 'ALL') return null;
  if (FOLDER_MAP[labelId]) return FOLDER_MAP[labelId];
  const lower = String(labelId).toLowerCase();
  const wellKnown = [
    'inbox',
    'sentitems',
    'deleteditems',
    'drafts',
    'junkemail',
    'archive',
    'outbox',
    'conversationhistory',
    'clutter',
    'conflicts',
    'msgfolderroot',
    'scheduled',
  ];
  if (wellKnown.includes(lower)) return lower;
  // Gmail-style ids must never hit Graph folder path
  if (/^(CATEGORY_|Label_|CHAT)/i.test(labelId) || ['STARRED', 'UNREAD', 'IMPORTANT'].includes(labelId)) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labelId)) {
    return labelId;
  }
  // Exchange/Graph opaque folder id (e.g. AQMkAGI2..., AAMkAGI2...)
  if (labelId.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(labelId)) {
    return labelId;
  }
  return null;
}

/**
 * Build Microsoft OAuth consent URL. State encodes userId for callback.
 */
export function getAuthUrl(userId) {
  const msalApp = createMsalApp();
  const state = Buffer.from(JSON.stringify({ userId: userId.toString() }), 'utf8').toString('base64url');
  return msalApp.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
    state,
    prompt: 'select_account',
  });
}

/**
 * Exchange authorization code for tokens, create/update EmailAccount.
 */
export async function handleCallback(code, userId) {
  const msalApp = createMsalApp();
  const uri = config.microsoft.redirectUri;
  logger.info('[Outlook] handleCallback exchange: userId=%s, redirectUri=%s, codePrefix=%s', userId, uri, code?.substring(0, 10));
  const tokenResponse = await msalApp.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: uri,
  });

  const client = createGraphClient(tokenResponse.accessToken);
  const me = await client.api('/me').select('mail,userPrincipalName').get();
  const email = (me.mail || me.userPrincipalName || '').toLowerCase();
  if (!email) throw new Error('Could not fetch user email from Microsoft');

  const tokenExpiry =
    tokenResponse.expiresOn != null
      ? new Date(tokenResponse.expiresOn)
      : new Date(Date.now() + 50 * 60 * 1000);

  const refreshToken =
    tokenResponse.refreshToken || extractRefreshTokenFromMsalCache(msalApp) || null;
  if (!refreshToken) {
    logger.warn(
      '[Outlook] No refresh token in MSAL cache after login — user must reconnect if mail stops working. Ensure offline_access scope and admin consent.'
    );
  }

  const existing = await EmailAccount.findOne({ user: userId, provider: 'outlook', email });
  if (existing) {
    existing.accessToken = tokenResponse.accessToken;
    if (refreshToken) existing.refreshToken = refreshToken;
    existing.tokenExpiry = tokenExpiry;
    existing.status = 'active';
    await existing.save();
    return existing;
  }

  const activeOutlookCount = await EmailAccount.countDocuments({
    user: userId,
    provider: 'outlook',
    status: 'active',
  });
  if (activeOutlookCount >= MAX_OUTLOOK_ACCOUNTS_PER_USER) {
    throw new Error(
      'Only one Outlook account is allowed. Disconnect it to connect a different mailbox.'
    );
  }

  return EmailAccount.create({
    user: userId,
    provider: 'outlook',
    email,
    accessToken: tokenResponse.accessToken,
    refreshToken,
    tokenExpiry,
    status: 'active',
  });
}

/**
 * Refresh access token via Microsoft token endpoint (reliable errors; MSAL refresh was opaque).
 * Persists rotated refresh_token when Microsoft returns one.
 */
/* In-flight refresh promises keyed by account _id to prevent concurrent refresh races */
const _refreshLocks = new Map();

async function _refreshTokenImpl(account) {
  const rt = (account.refreshToken || '').trim();
  if (!rt) {
    account.status = 'error';
    await account.save().catch(() => {});
    throw new ApiError(
      httpStatus.UNAUTHORIZED,
      'Outlook has no refresh token. Disconnect and connect Outlook again.',
      true,
      '',
      { subCode: 'outlook_reauth_required' }
    );
  }

  const { clientId, clientSecret, tenantId } = config.microsoft;
  const tenant = ((tenantId || 'common').trim() || 'common');
  const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

  async function tryRefresh(scopeStr) {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: rt,
      scope: scopeStr,
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: 'invalid_json', raw: text?.slice(0, 200) };
    }
    return { res: response, data: parsed };
  }

  let res;
  let data = {};
  try {
    ({ res, data } = await tryRefresh(REFRESH_TOKEN_SCOPE));
    if (data.error === 'invalid_scope' || (data.error === 'invalid_request' && String(data.error_description).includes('scope'))) {
      logger.warn('[Outlook] Retrying token refresh with narrower scopes');
      ({ res, data } = await tryRefresh(REFRESH_TOKEN_SCOPE_FALLBACK));
    }
  } catch (netErr) {
    logger.error('[Outlook] Token refresh network error: %s', netErr.message);
    throw new ApiError(httpStatus.BAD_GATEWAY, 'Could not reach Microsoft to refresh Outlook token.', true);
  }

  if (!res.ok || data.error) {
    logger.error('[Outlook] Token refresh failed HTTP %s: %s', res.status, JSON.stringify(data));
    account.status = 'error';
    await account.save().catch(() => {});

    const hint =
      data.error === 'invalid_client'
        ? 'Azure client secret may be wrong or expired — renew in App Registration → Certificates & secrets.'
        : data.error === 'invalid_grant'
          ? 'Refresh token expired or revoked — connect Outlook again.'
          : data.error === 'invalid_scope'
            ? 'Reconnect Outlook so we can request the correct permissions.'
            : data.error_description || data.error || 'Token refresh failed.';

    throw new ApiError(httpStatus.UNAUTHORIZED, String(hint).slice(0, 400), true, '', {
      subCode: 'outlook_reauth_required',
      details:
        config.env === 'development'
          ? { microsoft_error: data.error, microsoft_error_description: data.error_description }
          : undefined,
    });
  }

  if (!data.access_token) {
    logger.error('[Outlook] Refresh OK but no access_token: %s', JSON.stringify(data));
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Outlook token response invalid. Reconnect Outlook.', true, '', {
      subCode: 'outlook_reauth_required',
    });
  }

  account.accessToken = data.access_token;
  if (data.refresh_token) {
    account.refreshToken = data.refresh_token;
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  account.tokenExpiry = new Date(Date.now() + Math.max(60, expiresIn) * 1000);
  account.status = 'active';
  await account.save();
  return account;
}

/**
 * Locked version of token refresh — prevents concurrent refreshes for the same account
 * from racing and invalidating each other's tokens.
 */
export async function refreshToken(account) {
  const key = String(account._id || 'unknown');
  if (_refreshLocks.has(key)) {
    // Another caller is already refreshing this account — wait for it
    await _refreshLocks.get(key);
    // Reload the latest tokens from DB after the other refresh completed
    if (account._id) {
      const doc = await EmailAccount.findById(account._id).select('accessToken refreshToken tokenExpiry status').lean();
      if (doc?.accessToken) {
        account.accessToken = doc.accessToken;
        if (doc.refreshToken) account.refreshToken = doc.refreshToken;
        account.tokenExpiry = doc.tokenExpiry;
      }
      if (doc?.status === 'error') {
        throw new ApiError(httpStatus.UNAUTHORIZED, 'Outlook token refresh failed. Reconnect Outlook.', true);
      }
    }
    return account;
  }
  const promise = _refreshTokenImpl(account).finally(() => _refreshLocks.delete(key));
  _refreshLocks.set(key, promise);
  return promise;
}

async function ensureValidToken(account) {
  const expMs = account.tokenExpiry ? new Date(account.tokenExpiry).getTime() : 0;
  const bufferMs = 120000;
  const stale = !expMs || Number.isNaN(expMs) || Date.now() >= expMs - bufferMs;

  if (!account.refreshToken?.trim()) {
    if (stale) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'Outlook session expired. Disconnect and connect Outlook again.',
        true,
        '',
        { subCode: 'outlook_reauth_required' }
      );
    }
    return account;
  }
  if (stale) {
    await refreshToken(account);
  }
  return account;
}

function isGraphUnauthorized(err) {
  const s = err?.statusCode ?? err?.code ?? err?.status;
  return s === 401 || s === 'InvalidAuthenticationToken';
}

/**
 * ensureValidToken before first Graph call; on 401, refresh then retry.
 * Callbacks must use account.accessToken at execution time (e.g. createGraphClient(account.accessToken)
 * inside the arrow) — never capture the token in an outer const before with401Refresh.
 * After refresh we reload tokens from DB so retry never uses stale in-memory fields.
 */
async function with401Refresh(account, fn) {
  await ensureValidToken(account);
  try {
    return await fn();
  } catch (err) {
    if (isGraphUnauthorized(err) && account.refreshToken?.trim()) {
      logger.warn('[Outlook] Graph unauthorized, refreshing token and retrying');
      await refreshToken(account);
      if (account._id) {
        const doc = await EmailAccount.findById(account._id).select('accessToken refreshToken tokenExpiry').lean();
        if (doc?.accessToken) {
          account.accessToken = doc.accessToken;
          if (doc.refreshToken) account.refreshToken = doc.refreshToken;
          account.tokenExpiry = doc.tokenExpiry;
        }
      }
      try {
        return await fn();
      } catch (retryErr) {
        logger.error('[Outlook] with401Refresh retry also failed: statusCode=%s code=%s message=%s', retryErr.statusCode, retryErr.code, retryErr.message);
        throw retryErr;
      }
    }
    throw err;
  }
}

function normalizeFolder(folder) {
  const wellKnown = (folder.wellKnownName || '').toLowerCase();
  const mappedId = REVERSE_FOLDER_MAP[wellKnown];
  // Use mapped ID (e.g. INBOX) → well-known name (e.g. conversationhistory) → GUID
  const id = mappedId || wellKnown || folder.id;
  return {
    id,
    name: folder.displayName || folder.wellKnownName || folder.id,
    type: wellKnown ? 'system' : 'user',
  };
}

/**
 * Synthesize Gmail-compatible labelIds from Outlook message properties.
 * This allows the frontend to use the same labelIds logic for both providers.
 */
function stripTags(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>?/gm, '')
    .replace(/&lt;[^&]*&gt;/gm, '')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

/**
 * Same as Gmail (`gmailProvider.unescapeHtml`): composer often sends entity-encoded HTML.
 * Without this, Graph stores literal "&lt;p&gt;" or clients show raw tags.
 */
function unescapeHtml(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Wrap decoded HTML for Graph sendMail (HTML body). */
function outlookSendHtmlBody(html) {
  const raw = unescapeHtml((html || '').trim() || '<p></p>');
  if (/<\s*html[\s>]/i.test(raw)) return raw;
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head><body>${raw}</body></html>`;
}

/** Plain-text fallback / display cleanup (legacy messages that stored tags as text). */
function htmlToPlainTextForOutlookSend(html) {
  if (!html || !String(html).trim()) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n');
  s = s.replace(/<\/(blockquote|pre)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = parseInt(n, 10);
      return c >= 32 && c < 0x110000 ? String.fromCodePoint(c) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return c >= 32 && c < 0x110000 ? String.fromCodePoint(c) : ' ';
    });
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function synthesizeLabelIds(msg) {
  const ids = [];
  if (!msg.isRead) ids.push('UNREAD');
  if (msg.flag?.flagStatus === 'flagged') ids.push('STARRED');
  return ids;
}

function formatOutlookMessage(msg) {
  const ct = (msg.body?.contentType || '').toLowerCase();
  const htmlBody = ct === 'html' && msg.body?.content ? msg.body.content : null;
  let textBody = ct === 'text' && msg.body?.content ? msg.body.content : null;
  if (!htmlBody && !textBody && (msg.bodyPreview || '').trim()) {
    textBody = stripTags(msg.bodyPreview.trim());
  }
  if (textBody && !htmlBody && /<[a-z][^>]*>/i.test(textBody)) {
    const cleaned = htmlToPlainTextForOutlookSend(textBody);
    if (cleaned) textBody = cleaned;
  }
  return {
    id: msg.id,
    threadId: msg.conversationId || msg.id,
    labelIds: synthesizeLabelIds(msg),
    snippet: stripTags(msg.bodyPreview || '').slice(0, 200),
    from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`.trim() : '',
    to: (msg.toRecipients || []).map((r) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
    cc: (msg.ccRecipients || []).map((r) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
    subject: msg.subject || '(No subject)',
    date: msg.receivedDateTime || msg.sentDateTime || null,
    messageId: msg.internetMessageId || null,
    inReplyTo: null,
    references: null,
    isUnread: !msg.isRead,
    htmlBody,
    textBody,
    attachments: (msg.attachments || []).map((att) => ({
      filename: att.name || 'attachment',
      mimeType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      attachmentId: att.id,
      messageId: msg.id,
    })),
  };
}

function formatOutlookMessageListItem(msg) {
  return {
    id: msg.id,
    threadId: msg.conversationId || msg.id,
    labelIds: synthesizeLabelIds(msg),
    snippet: stripTags(msg.bodyPreview || '').slice(0, 200),
    from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`.trim() : '',
    to: (msg.toRecipients || []).map((r) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
    subject: msg.subject || '(No subject)',
    date: msg.receivedDateTime || msg.sentDateTime || null,
    isUnread: !msg.isRead,
  };
}

/**
 * List messages in a folder.
 * Pagination uses @odata.nextLink (Graph API does not support $skip for messages).
 */
export async function listMessages(account, { labelId, pageToken, pageSize = 20, query = '' } = {}) {
  const top = Math.min(pageSize || 20, 100);
  try {
    return await with401Refresh(account, async () => {
      const client = createGraphClient(account.accessToken);
      let res;
      if (pageToken) {
        res = await client.api(pageToken).get();
      } else {
        const folderId = resolveOutlookFolderId(labelId);
        const endpoint = folderId ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages` : '/me/messages';
        let request = client
          .api(endpoint)
          .top(top)
          .select('id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments');
        if (query && String(query).trim()) {
          request = request.search(`"${String(query).trim().replace(/"/g, '')}"`);
        } else if (folderId) {
          request = request.orderby('receivedDateTime desc');
        }
        res = await request.get();
      }
      const messages = (res.value || []).map(formatOutlookMessageListItem);
      return {
        messages,
        nextPageToken: res['@odata.nextLink'] || null,
        resultSizeEstimate: messages.length,
      };
    });
  } catch (err) {
    const detail = err.body ? JSON.stringify(err.body) : err.message;
    logger.error('[Outlook] listMessages Graph error: %s', detail);
    throw err;
  }
}

/**
 * List threads (group messages by conversationId).
 * Pagination uses @odata.nextLink (Graph API does not support $skip for messages).
 */
export async function listThreads(account, { labelId, pageToken, pageSize = 20, query = '' } = {}) {
  const top = Math.min(pageSize || 20, 100);
  let res;
  try {
    res = await with401Refresh(account, async () => {
      // Diagnostic 3: raw Graph response (set OUTLOOK_DEBUG_GRAPH=1). Remove when done debugging.
      if (process.env.OUTLOOK_DEBUG_GRAPH === '1') {
        const testRes = await fetch(
          'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=5&$select=id,subject',
          { headers: { Authorization: `Bearer ${(account.accessToken || '').trim()}` } }
        );
        const testBody = await testRes.json();
        // eslint-disable-next-line no-console
        console.error('[Outlook] RAW Graph test (listThreads):', testRes.status, JSON.stringify(testBody, null, 2));
      }
      const client = createGraphClient(account.accessToken);
      if (pageToken) {
        return client.api(pageToken).get();
      }
      const folderId = resolveOutlookFolderId(labelId);
      const endpoint = folderId ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages` : '/me/messages';
      let request = client
        .api(endpoint)
        .top(Math.min(top * 2, 100))
        .select('id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments');
      if (query && String(query).trim()) {
        request = request.search(`"${String(query).trim().replace(/"/g, '')}"`);
      } else if (folderId) {
        request = request.orderby('receivedDateTime desc');
      }
      return request.get();
    });
  } catch (err) {
    const detail = err.body ? JSON.stringify(err.body) : err.message;
    logger.error('[Outlook] listThreads Graph error: %s (statusCode=%s, code=%s, message=%s)', detail, err.statusCode, err.code, err.message);
    throw err;
  }

  const allMsgs = res.value || [];

  const threadMap = new Map();
  for (const msg of allMsgs) {
    const convId = msg.conversationId || msg.id;
    if (!threadMap.has(convId)) {
      threadMap.set(convId, { messages: [] });
    }
    threadMap.get(convId).messages.push(msg);
  }

  const threads = [];
  for (const [convId, data] of threadMap) {
    if (threads.length >= top) break;
    const msgs = data.messages;
    const latest = msgs[0];
    const first = msgs[msgs.length - 1];
    const isUnread = msgs.some((m) => !m.isRead);
    // Synthesize thread-level labelIds from all messages
    const threadLabelIds = [...new Set(msgs.flatMap(synthesizeLabelIds))];
    threads.push({
      id: convId,
      threadId: convId,
      snippet: stripTags(latest.bodyPreview || '').slice(0, 200),
      from: latest.from?.emailAddress ? `${latest.from.emailAddress.name || ''} <${latest.from.emailAddress.address}>`.trim() : '',
      to: (latest.toRecipients || []).map((r) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`).join(', '),
      subject: first.subject || '(No subject)',
      date: latest.receivedDateTime || latest.sentDateTime || null,
      messageCount: msgs.length,
      labelIds: threadLabelIds,
      isUnread,
    });
  }

  return {
    threads,
    nextPageToken: res['@odata.nextLink'] || null,
    resultSizeEstimate: threads.length,
  };
}

/**
 * Get full thread with all messages (conversation view by conversationId).
 */
export async function getThread(account, threadId) {
  return with401Refresh(account, async () => {
    const client = createGraphClient(account.accessToken);
    const escapedId = (threadId || '').replace(/'/g, "''");
    /** Do not $select body on list queries: Graph often returns truncated body (~preview length) when $top is large, which made us skip per-message fetch and showed only a few lines in the UI. */
    const res = await client
      .api('/me/messages')
      .filter(`conversationId eq '${escapedId}'`)
      .orderby('receivedDateTime asc')
      .select(
        'id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,internetMessageId,hasAttachments,flag'
      )
      .top(50)
      .get();
    const rows = res.value || [];
    const messages = await Promise.all(
      rows.map(async (row) => {
        try {
          const full = await client
            .api(`/me/messages/${row.id}`)
            .select(
              'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,internetMessageId,hasAttachments,flag'
            )
            .expand('attachments')
            .get();
          return formatOutlookMessage(full);
        } catch (e) {
          logger.warn('[Outlook] getThread message %s fetch failed: %s', row.id, e.message);
          return formatOutlookMessage(row);
        }
      })
    );
    return { id: threadId, messages };
  });
}

/**
 * Get full message with body and attachments.
 */
export async function getMessage(account, messageId) {
  return with401Refresh(account, async () => {
    const client = createGraphClient(account.accessToken);
    const msg = await client
      .api(`/me/messages/${messageId}`)
      .select('id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,internetMessageId,hasAttachments,flag')
      .get();
    return formatOutlookMessage(msg);
  });
}

/**
 * Get attachment content (base64).
 */
export async function getAttachment(account, messageId, attachmentId) {
  return with401Refresh(account, async () => {
    const client = createGraphClient(account.accessToken);
    const att = await client.api(`/me/messages/${messageId}/attachments/${attachmentId}`).get();
    return att.contentBytes || '';
  });
}

/**
 * Send a new email via Graph API.
 */
export async function sendMessage(account, { to, cc, bcc, subject, html, attachments = [] } = {}) {
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);

  const toRecipients = (Array.isArray(to) ? to : [to].filter(Boolean)).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = cc
    ? (Array.isArray(cc) ? cc : [cc]).map((addr) => ({ emailAddress: { address: addr } }))
    : [];
  const bccRecipients = bcc
    ? (Array.isArray(bcc) ? bcc : [bcc]).map((addr) => ({ emailAddress: { address: addr } }))
    : [];

  const message = {
    subject: subject || '',
    body: {
      contentType: 'HTML',
      content: outlookSendHtmlBody(html || ''),
    },
    toRecipients,
  };
  if (ccRecipients.length) message.ccRecipients = ccRecipients;
  if (bccRecipients.length) message.bccRecipients = bccRecipients;

  if (attachments.length > 0) {
    message.attachments = attachments.map((att) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename || 'attachment',
      contentType: att.mimeType || 'application/octet-stream',
      contentBytes: typeof att.content === 'string' ? att.content : Buffer.from(att.content).toString('base64'),
    }));
  }

  await client.api('/me/sendMail').post({ message, saveToSentItems: true });
  return { id: null, threadId: null };
}

/**
 * Reply to a message.
 */
export async function replyMessage(account, messageId, { html, attachments = [] } = {}) {
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);

  const replyHtml = outlookSendHtmlBody(html || '');
  if (attachments.length > 0) {
    const orig = await getMessage(account, messageId);
    const replyBody = {
      message: {
        body: {
          contentType: 'HTML',
          content: replyHtml,
        },
        toRecipients: [{ emailAddress: { address: orig.from.replace(/.*</, '').replace(/>.*/, '') } }],
        attachments: attachments.map((att) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: att.filename || 'attachment',
          contentType: att.mimeType || 'application/octet-stream',
          contentBytes: typeof att.content === 'string' ? att.content : Buffer.from(att.content).toString('base64'),
        })),
      },
      comment: '',
    };
    await client.api(`/me/messages/${messageId}/reply`).post(replyBody);
  } else {
    await client.api(`/me/messages/${messageId}/reply`).post({
      message: {
        body: {
          contentType: 'HTML',
          content: replyHtml,
        },
      },
      comment: '',
    });
  }

  return { id: null, threadId: null };
}

/**
 * Modify message (mark read/unread). Outlook doesn't have labels like Gmail;
 * we handle UNREAD by toggling isRead.
 */
export async function modifyMessage(account, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);

  const patch = {};
  if (removeLabelIds.includes('UNREAD')) patch.isRead = true;
  if (addLabelIds.includes('UNREAD')) patch.isRead = false;

  // Support STARRED via Outlook flag
  if (addLabelIds.includes('STARRED')) patch.flag = { flagStatus: 'flagged' };
  if (removeLabelIds.includes('STARRED')) patch.flag = { flagStatus: 'notFlagged' };

  if (Object.keys(patch).length > 0) {
    await client.api(`/me/messages/${messageId}`).patch(patch);
  }

  // Support SPAM → move to junkemail folder
  if (addLabelIds.includes('SPAM')) {
    try {
      await client.api(`/me/messages/${messageId}/move`).post({ destinationId: 'junkemail' });
    } catch (err) {
      logger.warn('[Outlook] Failed to move message %s to junk: %s', messageId, err.message);
    }
  }

  // Support INBOX removal → move to archive
  if (removeLabelIds.includes('INBOX') && !addLabelIds.includes('SPAM')) {
    try {
      await client.api(`/me/messages/${messageId}/move`).post({ destinationId: 'archive' });
    } catch (err) {
      logger.warn('[Outlook] Failed to archive message %s: %s', messageId, err.message);
    }
  }

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
 * Batch modify all messages in the given threads (conversation IDs).
 */
export async function batchModifyThreads(account, threadIds, { addLabelIds = [], removeLabelIds = [] } = {}) {
  if (!threadIds?.length) return { success: true, modified: 0 };
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);

  const allMessageIds = [];
  for (const convId of threadIds) {
    try {
      const escapedId = (convId || '').replace(/'/g, "''");
      const res = await client
        .api('/me/messages')
        .filter(`conversationId eq '${escapedId}'`)
        .select('id')
        .top(50)
        .get();
      for (const m of res.value || []) allMessageIds.push(m.id);
    } catch {
      // skip failed thread
    }
  }
  if (allMessageIds.length === 0) return { success: true, modified: 0 };
  return batchModifyMessages(account, allMessageIds, { addLabelIds, removeLabelIds });
}

/**
 * Trash a message (move to DeletedItems).
 */
export async function deleteMessage(account, messageId) {
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);
  await client.api(`/me/messages/${messageId}/move`).post({ destinationId: 'deleteditems' });
  return { success: true };
}

/**
 * Trash all messages in the given threads.
 */
export async function trashThreads(account, threadIds) {
  if (!threadIds?.length) return { success: true };
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);

  for (const convId of threadIds) {
    try {
      const escapedId = (convId || '').replace(/'/g, "''");
      const res = await client
        .api('/me/messages')
        .filter(`conversationId eq '${escapedId}'`)
        .select('id')
        .top(50)
        .get();
      for (const m of res.value || []) {
        await client.api(`/me/messages/${m.id}/move`).post({ destinationId: 'deleteditems' });
      }
    } catch {
      // skip
    }
  }
  return { success: true };
}

/**
 * List mail folders (mapped to label shape).
 * ensureValidToken runs only before the first fetch; after refresh, use the new access token directly
 * (do not call ensureValidToken again on retry — avoids double-refresh / stale reads).
 */
export async function listLabels(account) {
  const url = 'https://graph.microsoft.com/v1.0/me/mailFolders?$top=200';

  const fetchFolders = async (token) => {
    const t = (token || '').trim();
    if (!t) throw new Error('No access token after Outlook refresh');
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: 'application/json',
      },
    });
  };

  await ensureValidToken(account);
  let r = await fetchFolders(account.accessToken);

  if (r.status === 401) {
    if (!account.refreshToken?.trim()) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'Outlook mail access unauthorized. Disconnect and connect Outlook again.',
        true,
        '',
        { subCode: 'outlook_reauth_required' }
      );
    }
    logger.warn('[Outlook] mailFolders 401, refreshing token');
    await refreshToken(account);
    r = await fetchFolders(account.accessToken);
  }
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    logger.error('[Outlook] listLabels non-JSON status=%s body=%s', r.status, text.slice(0, 500));
    throw new Error(`Graph mailFolders: ${r.status}`);
  }
  if (!r.ok) {
    logger.error('[Outlook] listLabels HTTP %s: %s', r.status, JSON.stringify(data));
    if (r.status === 401) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'Outlook mail access unauthorized. Disconnect and connect Outlook again.',
        true,
        '',
        { subCode: 'outlook_reauth_required' }
      );
    }
    const msg = data.error?.message || data.error?.code || `HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { statusCode: r.status, body: data });
  }
  const folders = data.value || [];
  return folders.map(normalizeFolder);
}

/**
 * Create a new mail folder.
 */
export async function createLabel(account, { name }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Label name is required');
  }
  await ensureValidToken(account);
  const client = createGraphClient(account.accessToken);
  const folder = await client.api('/me/mailFolders').post({ displayName: name.trim() });
  return normalizeFolder(folder);
}
