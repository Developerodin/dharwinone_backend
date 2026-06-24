import EmailAccount from '../models/emailAccount.model.js';
import * as gmailProvider from '../services/emailProviders/gmailProvider.js';
import * as outlookProvider from '../services/emailProviders/outlookProvider.js';
import { sendPushToUser } from '../services/push.service.js';
import logger from '../config/logger.js';

const POLL_INTERVAL_MS = 60 * 1000;
// Don't notify for more than this many individual messages per account per tick; beyond it,
// send a single summary push so a backlog never spams the device.
const MAX_INDIVIDUAL = 3;

function providerFor(account) {
  if (account.provider === 'gmail') return gmailProvider;
  if (account.provider === 'outlook') return outlookProvider;
  return null;
}

function senderName(from) {
  // "Name <email>" -> "Name"; bare "email" -> "email"
  const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  return (m ? m[1] : String(from || '')).trim() || 'Someone';
}

async function pollAccount(account) {
  const provider = providerFor(account);
  if (!provider?.getNewInboxMessages) return;

  // First run: set a baseline and skip — avoids blasting pushes for pre-existing mail.
  if (!account.lastNotifiedAt) {
    account.lastNotifiedAt = new Date();
    await account.save();
    return;
  }

  const messages = await provider.getNewInboxMessages(account, account.lastNotifiedAt);
  if (!messages.length) return;

  const newest = Math.max(...messages.map((m) => m.internalMs));
  account.lastNotifiedAt = new Date(newest);
  await account.save();

  if (messages.length <= MAX_INDIVIDUAL) {
    for (const msg of messages) {
      // eslint-disable-next-line no-await-in-loop
      await sendPushToUser(account.user, {
        title: `New email · ${senderName(msg.from)}`,
        body: msg.subject,
        data: { type: 'new_email', provider: account.provider, accountId: String(account._id), messageId: msg.id },
      }).catch((e) => logger.warn('[emailPoller] push failed: %s', e?.message || e));
    }
  } else {
    await sendPushToUser(account.user, {
      title: `${messages.length} new emails`,
      body: `in ${account.email}`,
      data: { type: 'new_email', provider: account.provider, accountId: String(account._id) },
    }).catch((e) => logger.warn('[emailPoller] push failed: %s', e?.message || e));
  }
}

export async function pollNewMail() {
  const accounts = await EmailAccount.find({ status: 'active', provider: { $in: ['gmail', 'outlook'] } });
  for (const account of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pollAccount(account);
    } catch (err) {
      logger.warn('[emailPoller] account %s (%s) failed: %s', String(account._id), account.provider, err?.message || err);
    }
  }
}

let intervalHandle = null;

export function startEmailNotificationPoller(intervalMs = POLL_INTERVAL_MS) {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    pollNewMail().catch((err) => logger.error('[emailPoller] error: %s', err?.message || err));
  }, intervalMs);
  intervalHandle.unref();
  logger.info('[emailPoller] started (interval=%dms)', intervalMs);
}

export function stopEmailNotificationPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
