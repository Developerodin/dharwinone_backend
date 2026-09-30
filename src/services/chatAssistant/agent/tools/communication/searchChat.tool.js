import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  CHAT_ACCESS, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, bound, communicationDeps, communicationUserId,
} from './common.js';

// The chat sidebar's page size cap (chat.validation listConversations limit max 50).
const MAX_CONVERSATIONS_SEARCHED = 50;
const MAX_SNIPPET_CHARS = 300;

const toHit = (conv) => (m) => ({
  conversationId: conv.id,
  conversation: conv.displayName || conv.name || null,
  conversationType: conv.type || null,
  author: m.sender?.name || null,
  at: m.createdAt ?? null,
  snippet: bound(m.content, MAX_SNIPPET_CHARS),
});

export default defineTool({
  name: 'search_chat',
  domain: 'communication',
  kind: 'read',
  description:
    'Search chat messages (Communication → Chats) in conversations the signed-in user is a member of: ' +
    'conversation, author, time and a text snippet, newest first. Optionally narrow to one conversation ' +
    'by group name or the other person\'s name. Use for "did anyone mention the release in chat", "what did ' +
    'Ravi say about the deadline", "find the chat where we discussed the invoice".',
  measure:
    'Chat MESSAGES matching the text in your own conversations (your most recent 50 conversations at most; ' +
    'deleted and hidden messages excluded). total is the matches found there, capped per conversation at limit.',
  input: Joi.object({
    query: Joi.string().min(1).max(200).required().description('Text to find in message content (case-insensitive).'),
    conversation: Joi.string().min(2).max(100)
      .description('Only conversations whose group name, or the other person\'s name / email, contains this.'),
    type: Joi.string().valid('direct', 'group').description('direct = one-to-one chats; group = group chats.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  }),
  access: CHAT_ACCESS,
  /**
   * listConversations returns only the caller's conversations; searchMessages re-checks membership
   * (ensureParticipant) for each. Ceiling: one indexed regex query per conversation, and only the
   * most recent MAX_CONVERSATIONS_SEARCHED conversations — `partial` says when that cut anything.
   */
  async execute({ query, conversation, type, limit = DEFAULT_LIST_LIMIT } = {}, ctx) {
    const userId = communicationUserId(ctx);
    const deps = communicationDeps(ctx);
    const convs = await deps.listConversations(userId, {
      page: 1, limit: MAX_CONVERSATIONS_SEARCHED, ...(type ? { type } : {}), ...(conversation ? { q: conversation } : {}),
    });
    const list = convs?.results || [];
    const perConversation = await Promise.all(list.map(async (conv) => {
      const res = await deps.searchMessages(String(conv.id), userId, { q: query, limit });
      return (res?.results || []).map(toHit(conv));
    }));
    const hits = perConversation.flat()
      .sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
    const conversationsTotal = convs?.total ?? list.length;
    return {
      total: hits.length,
      messages: hits.slice(0, limit),
      conversationsSearched: list.length,
      conversationsTotal,
      partial: conversationsTotal > list.length || perConversation.some((rows) => rows.length >= limit),
    };
  },
  render(result) {
    if (!result?.messages?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'chat-search',
        tableType: 'chat-search',
        title: `Chat messages (${result.total})`,
        columns: [
          { key: 'conversation', label: 'Conversation', priority: 'primary' },
          { key: 'author', label: 'From', priority: 'primary' },
          { key: 'at', label: 'When', priority: 'primary' },
          { key: 'snippet', label: 'Message', priority: 'secondary' },
        ],
        rows: result.messages.map((m) => ({
          conversation: m.conversation ?? '—',
          author: m.author ?? '—',
          at: m.at ? new Date(m.at).toISOString() : '—',
          snippet: m.snippet ?? '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
