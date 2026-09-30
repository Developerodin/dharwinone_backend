import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  MAILBOX_ACCESS, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, bound, communicationDeps, communicationUserId, isoDate, plainBody,
} from './common.js';

const MAX_SNIPPET_CHARS = 200;
const MAX_THREAD_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 1200;
const NO_MAILBOX = 'No connected mailbox — connect Gmail or Outlook in Communication → Email.';

/** The caller's own active mailboxes (both client services filter on user). */
async function myAccounts(userId, deps) {
  const [gmail, outlook] = await Promise.all([deps.listGmailAccounts(userId), deps.listOutlookAccounts(userId)]);
  return [...(gmail || []), ...(outlook || [])].map((a) => ({ id: String(a.id ?? a._id), provider: a.provider, email: a.email }));
}

const toThread = (account) => (t) => ({
  threadId: t.threadId ?? t.id,
  accountId: account.id,
  mailbox: account.email,
  subject: t.subject || null,
  from: t.from || null,
  date: isoDate(t.date),
  snippet: bound(t.snippet, MAX_SNIPPET_CHARS),
  messageCount: t.messageCount ?? null,
  isUnread: !!t.isUnread,
});

/**
 * One provider search per connected account, merged newest first. A failing account (expired
 * token, provider outage) is reported in accountErrors instead of failing the whole search.
 * Ceiling: Gmail fetches one metadata call per thread, so pageSize is the limit, not more.
 */
/**
 * outlookProvider.listThreads wraps the whole query in quotes (one KQL phrase), so "offer Priya" would only
 * match that exact phrase. With both words and a person, Outlook searches the words and the person is
 * matched here against the thread's from / to / cc. Gmail's q ANDs plain words, so it gets both.
 */
const mentionsPerson = (t, person) =>
  [t.from, t.to, t.cc].some((v) => String(v || '').toLowerCase().includes(person.toLowerCase()));

async function searchThreads(accounts, userId, { query, person }, limit, deps) {
  const accountErrors = [];
  let moreAvailable = false;
  const both = [query, person].filter(Boolean).join(' ').trim();
  const perAccount = await Promise.all(accounts.map(async (account) => {
    const outlook = account.provider === 'outlook';
    const list = outlook ? deps.listOutlookThreads : deps.listGmailThreads;
    const splitPerson = outlook && query && person;
    try {
      const res = await list(account.id, userId, { query: splitPerson ? query : both, pageSize: limit });
      if (res?.nextPageToken) moreAvailable = true;
      const rows = res?.threads || [];
      return (splitPerson ? rows.filter((t) => mentionsPerson(t, person)) : rows).map(toThread(account));
    } catch {
      accountErrors.push({ mailbox: account.email, error: 'Could not search this mailbox; it may need reconnecting.' });
      return [];
    }
  }));
  const threads = perAccount.flat()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit);
  return { threads, moreAvailable: moreAvailable || perAccount.flat().length > limit, accountErrors };
}

/** The latest messages of one thread as bounded plain text, so the reply can summarise it. */
async function readThread(account, userId, threadId, deps) {
  const get = account.provider === 'outlook' ? deps.getOutlookThread : deps.getGmailThread;
  const thread = await get(account.id, userId, threadId);
  const all = thread?.messages || [];
  const messages = all.slice(-MAX_THREAD_MESSAGES).map((m) => ({
    from: m.from || null,
    to: m.to || null,
    date: isoDate(m.date),
    subject: m.subject || null,
    text: bound(plainBody(m), MAX_MESSAGE_CHARS),
    attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0,
  }));
  return {
    found: true,
    thread: {
      threadId,
      accountId: account.id,
      mailbox: account.email,
      subject: messages[0]?.subject ?? null,
      messageCount: all.length,
      messages,
      ...(all.length > messages.length ? { olderMessagesOmitted: all.length - messages.length } : {}),
    },
  };
}

export default defineTool({
  name: 'search_my_mailbox',
  domain: 'communication',
  kind: 'read',
  description:
    'Search the signed-in user\'s OWN connected mailbox (Gmail / Outlook in Communication → Email) for ' +
    'threads matching words and/or a person: subject, sender, date and a short snippet. To summarise one ' +
    'thread, call again with its threadId and accountId from a previous result — that returns the latest ' +
    'messages as text. Use for "any emails from Priya about the offer", "find the thread about the invoice", ' +
    '"summarise that email thread". Never reads anyone else\'s mailbox.',
  measure:
    'Email THREADS in your own connected mailboxes that the provider search returned (newest first). total ' +
    'is the number returned here, not the mailbox-wide match count; moreAvailable says there are more.',
  input: Joi.object({
    query: Joi.string().min(1).max(200).description('Plain words to search for (subject, body, names).'),
    person: Joi.string().min(1).max(200)
      .description('A name or email address; matched by the mailbox search across sender, recipients and text.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
    threadId: Joi.string().min(1).max(300).description('Read this thread (from a previous search result) to summarise it.'),
    accountId: Joi.string().min(1).max(64).description('The accountId that came with threadId.'),
  }),
  access: MAILBOX_ACCESS,
  async execute({ query, person, limit = DEFAULT_LIST_LIMIT, threadId, accountId } = {}, ctx) {
    const userId = communicationUserId(ctx);
    const deps = communicationDeps(ctx);
    const accounts = await myAccounts(userId, deps);
    if (!accounts.length) return { connected: false, total: 0, threads: [], note: NO_MAILBOX };

    if (threadId) {
      const account = accountId ? accounts.find((a) => a.id === accountId) : accounts.length === 1 ? accounts[0] : null;
      if (!account) return { found: false, note: 'Give the accountId returned with that thread (one of your connected mailboxes).' };
      return readThread(account, userId, threadId, deps);
    }

    if (!String(query || '').trim() && !String(person || '').trim()) throw new Error('Give words to search for or a person.');
    const { threads, moreAvailable, accountErrors } = await searchThreads(
      accounts, userId, { query: query?.trim(), person: person?.trim() }, limit, deps,
    );
    return {
      connected: true,
      mailboxes: accounts.map((a) => a.email),
      total: threads.length,
      moreAvailable,
      threads,
      ...(accountErrors.length ? { accountErrors } : {}),
    };
  },
  render(result) {
    if (!result?.threads?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'mailbox-threads',
        tableType: 'mailbox-threads',
        title: `Email threads (${result.total})`,
        columns: [
          { key: 'subject', label: 'Subject', priority: 'primary' },
          { key: 'from', label: 'From', priority: 'primary' },
          { key: 'date', label: 'Date', priority: 'primary' },
          { key: 'snippet', label: 'Snippet', priority: 'secondary' },
        ],
        rows: result.threads.map((t) => ({
          subject: t.subject ?? '—', from: t.from ?? '—', date: t.date ?? '—', snippet: t.snippet ?? '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
