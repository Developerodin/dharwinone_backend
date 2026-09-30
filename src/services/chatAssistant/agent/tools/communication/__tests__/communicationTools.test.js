import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import searchMyMailbox from '../searchMyMailbox.tool.js';
import searchChat from '../searchChat.tool.js';
import listEmailActivity from '../listEmailActivity.tool.js';
import communicationDomain from '../index.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const VIEWER = { id: 'u1', _id: 'u1' };
const withPerms = (...perms) => ({ id: 'u1', authContext: { permissions: new Set(perms) } });

describe('communication domain', () => {
  it('exports a one-line summary and all three tools', () => {
    assert.equal(communicationDomain.domain, 'communication');
    assert.ok(communicationDomain.summary.length <= 120 && !/\n/.test(communicationDomain.summary));
    assert.deepEqual(communicationDomain.tools.map((t) => t.name), ['search_my_mailbox', 'search_chat', 'list_email_activity']);
  });
});

describe('search_my_mailbox', () => {
  const GMAIL = { id: 'a-g', provider: 'gmail', email: 'me@gmail.com', status: 'active' };
  const OUTLOOK = { id: 'a-o', provider: 'outlook', email: 'me@corp.com', status: 'active' };

  function ctx(extra = {}) {
    return {
      user: VIEWER,
      deps: {
        listGmailAccounts: async () => [GMAIL],
        listOutlookAccounts: async () => [OUTLOOK],
        listGmailThreads: async () => ({ threads: [] }),
        listOutlookThreads: async () => ({ threads: [] }),
        getGmailThread: async () => ({ messages: [] }),
        getOutlookThread: async () => ({ messages: [] }),
        ...extra,
      },
    };
  }

  it('needs emails.read (the /email/threads route permission)', async () => {
    assert.equal((await checkAccessRule(searchMyMailbox.access, withPerms('chats.read'))).ok, false);
    assert.equal((await checkAccessRule(searchMyMailbox.access, withPerms('emails.read'))).ok, true);
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(searchMyMailbox.execute({ query: 'x' }, { deps: ctx().deps }), /user with an id/);
  });

  it('no connected mailbox → connected false with a note, no provider call', async () => {
    let searched = false;
    const out = await searchMyMailbox.execute({ query: 'offer' }, ctx({
      listGmailAccounts: async () => [],
      listOutlookAccounts: async () => [],
      listGmailThreads: async () => { searched = true; return {}; },
    }));
    assert.equal(searched, false);
    assert.equal(out.connected, false);
    assert.equal(out.total, 0);
    assert.match(out.note, /connect Gmail or Outlook/);
  });

  it('searches each of the viewer\'s own accounts with their user id and merges newest first', async () => {
    const calls = [];
    const out = await searchMyMailbox.execute({ query: 'offer', person: 'Priya', limit: 5 }, ctx({
      listGmailAccounts: async (userId) => { calls.push(['gmailAccounts', userId]); return [GMAIL]; },
      listOutlookAccounts: async (userId) => { calls.push(['outlookAccounts', userId]); return [OUTLOOK]; },
      listGmailThreads: async (accountId, userId, opts) => {
        calls.push(['gmail', accountId, userId, opts]);
        return {
          threads: [{
            id: 't1', threadId: 't1', subject: 'Offer letter', from: 'Priya <p@x.com>', to: 'me@gmail.com',
            cc: 'boss@x.com', labelIds: ['INBOX'], date: 'Mon, 28 Sep 2026 10:00:00 +0000', snippet: 'Please find', messageCount: 3,
            isUnread: true,
          }],
          nextPageToken: 'n',
        };
      },
      listOutlookThreads: async (accountId, userId, opts) => {
        calls.push(['outlook', accountId, userId, opts]);
        return { threads: [{ id: 'c1', subject: 'Re: offer', from: 'Priya <p@corp.com>', date: '2026-09-29T09:00:00Z', snippet: 'Signed' }] };
      },
    }));
    assert.deepEqual(calls.slice(0, 2), [['gmailAccounts', 'u1'], ['outlookAccounts', 'u1']]);
    assert.deepEqual(calls.slice(2).sort((a, b) => a[0].localeCompare(b[0])), [
      ['gmail', 'a-g', 'u1', { query: 'offer Priya', pageSize: 5 }],
      // Outlook wraps the query in one KQL phrase, so the person is matched on from / to / cc instead.
      ['outlook', 'a-o', 'u1', { query: 'offer', pageSize: 5 }],
    ]);
    assert.equal(out.connected, true);
    assert.equal(out.total, 2);
    assert.equal(out.moreAvailable, true);
    assert.deepEqual(out.threads.map((t) => t.threadId), ['c1', 't1']);
    assert.deepEqual(out.threads[1], {
      threadId: 't1', accountId: 'a-g', mailbox: 'me@gmail.com', subject: 'Offer letter', from: 'Priya <p@x.com>',
      date: '2026-09-28T10:00:00.000Z', snippet: 'Please find', messageCount: 3, isUnread: true,
    });
    assert.equal(out.threads[0].messageCount, null);
  });

  it('Outlook with words + person: searches the words, keeps only threads that involve the person', async () => {
    const out = await searchMyMailbox.execute({ query: 'invoice', person: 'priya' }, ctx({
      listGmailAccounts: async () => [],
      listOutlookThreads: async () => ({ threads: [
        { id: 'c1', subject: 'Invoice', from: 'Priya Rao <p@corp.com>', to: 'me@corp.com', date: '2026-09-29T09:00:00Z' },
        { id: 'c2', subject: 'Invoice', from: 'Acme <billing@acme.com>', to: 'me@corp.com', date: '2026-09-29T08:00:00Z' },
        { id: 'c3', subject: 'Invoice', from: 'Me <me@corp.com>', cc: 'PRIYA <p@corp.com>', date: '2026-09-28T08:00:00Z' },
      ] }),
    }));
    assert.deepEqual(out.threads.map((t) => t.threadId), ['c1', 'c3']);
  });

  it('Outlook with only a person searches the person as the phrase', async () => {
    let seen;
    await searchMyMailbox.execute({ person: 'Priya Rao' }, ctx({
      listGmailAccounts: async () => [],
      listOutlookThreads: async (a, u, opts) => { seen = opts; return { threads: [] }; },
    }));
    assert.equal(seen.query, 'Priya Rao');
  });

  it('one failing mailbox is reported, the other still answers', async () => {
    const out = await searchMyMailbox.execute({ query: 'x' }, ctx({
      listGmailThreads: async () => { throw new Error('invalid_grant token=secret'); },
      listOutlookThreads: async () => ({ threads: [{ id: 'c1', subject: 's', date: '2026-09-29T09:00:00Z' }] }),
    }));
    assert.equal(out.total, 1);
    assert.deepEqual(out.accountErrors, [{ mailbox: 'me@gmail.com', error: 'Could not search this mailbox; it may need reconnecting.' }]);
    assert.ok(!JSON.stringify(out).includes('secret'));
  });

  it('never reads a thread through an account the viewer does not own', async () => {
    let read = false;
    const out = await searchMyMailbox.execute({ threadId: 't1', accountId: 'someone-elses' }, ctx({
      getGmailThread: async () => { read = true; return {}; },
      getOutlookThread: async () => { read = true; return {}; },
    }));
    assert.equal(read, false);
    assert.equal(out.found, false);
  });

  it('thread mode returns the latest messages as bounded plain text for a summary', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      from: `P${i} <p${i}@x.com>`, to: 'me@corp.com', date: `2026-09-${String(10 + i).padStart(2, '0')}T09:00:00Z`,
      subject: 'Invoice', htmlBody: `<p>Hello <b>${i}</b></p><script>evil()</script>`, attachments: i === 11 ? [{}] : [],
    }));
    let seen;
    const out = await searchMyMailbox.execute({ threadId: 'c1', accountId: 'a-o' }, ctx({
      getOutlookThread: async (accountId, userId, threadId) => { seen = { accountId, userId, threadId }; return { messages }; },
    }));
    assert.deepEqual(seen, { accountId: 'a-o', userId: 'u1', threadId: 'c1' });
    assert.equal(out.found, true);
    assert.equal(out.thread.messageCount, 12);
    assert.equal(out.thread.messages.length, 10);
    assert.equal(out.thread.olderMessagesOmitted, 2);
    assert.equal(out.thread.messages[9].text, 'Hello 11');
    assert.equal(out.thread.messages[9].attachmentCount, 1);
  });

  it('missing subject / sender / body come back null', async () => {
    const out = await searchMyMailbox.execute({ threadId: 't1', accountId: 'a-g' }, ctx({
      getGmailThread: async () => ({ messages: [{ date: null }] }),
    }));
    assert.deepEqual(out.thread.messages[0], { from: null, to: null, date: null, subject: null, text: null, attachmentCount: 0 });
  });

  it('needs words, a person or a thread', async () => {
    await assert.rejects(searchMyMailbox.execute({}, ctx()), /words to search for or a person/);
  });
});

describe('search_chat', () => {
  const CONVS = {
    total: 2,
    results: [
      { id: 'c1', type: 'group', displayName: 'Release squad' },
      { id: 'c2', type: 'direct', displayName: 'Ravi' },
    ],
  };

  function ctx(extra = {}) {
    return {
      user: VIEWER,
      deps: {
        listConversations: async () => CONVS,
        searchMessages: async () => ({ results: [] }),
        ...extra,
      },
    };
  }

  it('needs chats.read (the chat router permission)', async () => {
    assert.equal((await checkAccessRule(searchChat.access, withPerms('emails.read'))).ok, false);
    assert.equal((await checkAccessRule(searchChat.access, withPerms('chats.read'))).ok, true);
  });

  it('requires a query', () => {
    assert.ok(searchChat.input.validate({}).error);
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(searchChat.execute({ query: 'x' }, { deps: ctx().deps }), /user with an id/);
  });

  it('searches only the viewer\'s conversations, newest match first, author name only', async () => {
    const calls = [];
    const out = await searchChat.execute({ query: 'release', conversation: 'squad', type: 'group', limit: 10 }, ctx({
      listConversations: async (userId, opts) => { calls.push(['list', userId, opts]); return CONVS; },
      searchMessages: async (convId, userId, opts) => {
        calls.push(['search', convId, userId, opts]);
        return convId === 'c1'
          ? { results: [{ content: 'release is Friday', createdAt: '2026-09-28T10:00:00Z', sender: { name: 'Asha', email: 'asha@x.com' } }] }
          : { results: [{ content: 'moved the release', createdAt: '2026-09-29T10:00:00Z', sender: { name: 'Ravi', email: 'r@x.com' } }] };
      },
    }));
    assert.deepEqual(calls[0], ['list', 'u1', { page: 1, limit: 50, type: 'group', q: 'squad' }]);
    assert.deepEqual(calls.slice(1).map((c) => c[1]).sort(), ['c1', 'c2']);
    assert.ok(calls.slice(1).every((c) => c[2] === 'u1' && c[3].q === 'release' && c[3].limit === 10));
    assert.equal(out.total, 2);
    assert.equal(out.partial, false);
    assert.deepEqual(out.messages[0], {
      conversationId: 'c2', conversation: 'Ravi', conversationType: 'direct', author: 'Ravi',
      at: '2026-09-29T10:00:00Z', snippet: 'moved the release',
    });
    assert.ok(!JSON.stringify(out).includes('@x.com'));
  });

  it('missing author / content come back null; partial when conversations were cut', async () => {
    const out = await searchChat.execute({ query: 'x' }, ctx({
      listConversations: async () => ({ total: 80, results: [CONVS.results[0]] }),
      searchMessages: async () => ({ results: [{ content: '', createdAt: null, sender: null }] }),
    }));
    assert.deepEqual(out.messages[0], {
      conversationId: 'c1', conversation: 'Release squad', conversationType: 'group', author: null, at: null, snippet: null,
    });
    assert.equal(out.conversationsSearched, 1);
    assert.equal(out.conversationsTotal, 80);
    assert.equal(out.partial, true);
  });
});

describe('list_email_activity', () => {
  const ADMIN = { id: 'u1', _id: 'u1' };
  const LOG = {
    _id: 'l1', to: 'priya@x.com', subject: 'Your offer letter', templateName: 'notification_offer', status: 'failed',
    error: 'Connection timeout', sentAt: null, createdAt: new Date('2026-09-29T05:00:00Z'), metadata: { token: 'secret' },
  };

  function ctx(extra = {}) {
    const seen = {};
    return {
      seen,
      user: ADMIN,
      deps: {
        queryUsers: async () => ({ results: [] }),
        queryEmailLogs: async (filter, opts) => { seen.filter = filter; seen.opts = opts; return { total: 1, results: [LOG] }; },
        User: {
          distinct: async () => [],
          find: () => ({ select: () => ({ lean: async () => [{ name: 'Priya Rao', email: 'priya@x.com' }] }) }),
        },
        viewerSeesHiddenUsers: () => true,
        getDirectoryHiddenUserIds: async () => [],
        ...extra,
      },
    };
  }

  it('Administrator by role name or the Activity Logs delete tier only', async () => {
    const isAdmin = async (u) => u.admin === true;
    const check = (u) => checkAccessRule(listEmailActivity.access, u, { isAdmin });
    assert.equal((await check({ ...withPerms('emails.read', 'activity.read', 'activity.manage') })).ok, false);
    assert.equal((await check({ ...withPerms('activity.delete') })).ok, true);
    assert.equal((await check({ ...withPerms(), admin: true })).ok, true);
    assert.equal((await check({ ...withPerms(), platformSuperUser: true })).ok, true);
  });

  it('fails closed without a user id', async () => {
    await assert.rejects(listEmailActivity.execute({}, { deps: ctx().deps }), /user with an id/);
  });

  it('a name resolves through the Users directory to login + company emails; rows carry no metadata', async () => {
    const c = ctx({
      queryUsers: async (filter, opts, viewer) => {
        c.seen.users = { filter, opts, viewer };
        return { results: [{ name: 'Priya Rao', email: 'Priya@x.com', companyAssignedEmail: 'priya@corp.com' }] };
      },
    });
    const out = await listEmailActivity.execute({ filters: { person: 'Priya', type: 'offer', status: 'failed' } }, c);
    assert.deepEqual(c.seen.users.filter, { search: 'Priya', platformSuperUser: { $ne: true } });
    assert.equal(c.seen.users.viewer, ADMIN);
    assert.deepEqual(c.seen.filter.$and, [
      { to: { $in: ['priya@x.com', 'priya@corp.com'] } },
      { status: 'failed' },
      { templateName: { $regex: 'offer', $options: 'i' } },
    ]);
    assert.equal(c.seen.opts.limit, 20);
    assert.equal(out.total, 1);
    assert.deepEqual(out.records[0], {
      to: 'priya@x.com', person: 'Priya Rao', type: 'notification_offer', subject: 'Your offer letter', status: 'failed',
      error: 'Connection timeout', sentAt: null, attemptedAt: LOG.createdAt,
    });
    assert.ok(!JSON.stringify(out).includes('secret'));
  });

  it('an unknown name returns notFound without reading the log', async () => {
    const c = ctx();
    const out = await listEmailActivity.execute({ filters: { person: 'Nobody' } }, c);
    assert.equal(out.notFound, 'person');
    assert.equal(out.total, 0);
    assert.equal(c.seen.filter, undefined);
  });

  it('an address is matched as escaped text (no regex injection); the window is whole IST days', async () => {
    const c = ctx();
    await listEmailActivity.execute({ filters: { person: 'A.Sha+1@x.com', between: { from: '2026-09-29', to: '2026-09-29' } } }, c);
    assert.deepEqual(c.seen.filter.$and, [
      { to: { $regex: 'a\\.sha\\+1@x\\.com' } },
      { createdAt: { $gte: new Date('2026-09-28T18:30:00.000Z'), $lte: new Date('2026-09-29T18:29:59.999Z') } },
    ]);
  });

  it('mail to directory-hidden accounts is excluded for viewers who cannot see them', async () => {
    const c = ctx({
      viewerSeesHiddenUsers: () => false,
      getDirectoryHiddenUserIds: async () => ['h1'],
      User: {
        distinct: async (field, q) => { assert.deepEqual([field, q], ['email', { _id: { $in: ['h1'] } }]); return ['Root@X.com']; },
        find: () => ({ select: () => ({ lean: async () => [] }) }),
      },
    });
    const out = await listEmailActivity.execute({}, c);
    assert.deepEqual(c.seen.filter, { $and: [{ to: { $nin: ['root@x.com'] } }] });
    assert.equal(out.records[0].person, null);
  });

  it('rejects an unknown status and caps limit at 50', () => {
    assert.ok(listEmailActivity.input.validate({ filters: { status: 'bounced' } }).error);
    assert.ok(listEmailActivity.input.validate({ limit: 51 }).error);
  });
});
