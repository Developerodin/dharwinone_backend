import OpenAI from 'openai';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import { envelope } from './chatAssistant/renderers/types.js';
import { tryAgentTurn } from './chatAssistant/agent/gate.js';

// Sage (the chat assistant). Every turn goes through the tool-calling agent loop
// (chatAssistant/agent/, see its README); a turn the agent does not answer gets a
// fixed reply from agent/gate.js, so a request never goes dark.

const MAX_HISTORY_TURNS = 6;

/**
 * One turn, shared by both routes. The agent has no token streaming, so the
 * stream route sends the finished reply as a single token.
 * @returns {Promise<object>} the { reply, blocks, meta } envelope
 */
async function answerTurn({ messages, user, requestId, stream, deps }) {
  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'AI service is not configured');
  }

  const client = new OpenAI({ apiKey });
  const history = messages
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }))
    .filter((m) => m.content && String(m.content).trim().length > 0);

  const userId = user?.id;
  const adminId = user?.adminId ?? userId;

  const turn = await tryAgentTurn({ client, user, adminId, history, requestId, deps });
  logger.info(
    `[ChatAssistant${stream ? ':stream' : ''}] user=${userId} outcome=${turn.outcome} steps=${turn.meta?.steps ?? 0} tools=[${turn.meta?.toolCalls ?? ''}] requestId=${requestId ?? 'none'}`
  );
  return envelope({
    reply: turn.reply,
    blocks: turn.blocks,
    meta:
      turn.outcome === 'answer'
        ? { kind: 'jobs', deterministic: false, tookMs: turn.meta?.ms }
        : { kind: null, deterministic: false },
  });
}

/**
 * Non-streaming response.
 * @param {{ messages: {role: string, content: string}[], user: object, requestId?: string|null, deps?: object }} opts
 *   `deps` is a test override passed to agent/gate.js's tryAgentTurn.
 */
export async function sendMessage({ messages, user, requestId = null, deps }) {
  return answerTurn({ messages, user, requestId, stream: false, deps });
}

/**
 * Streaming response via SSE callbacks: one `onToken` with the whole reply, then
 * `onDone` with the envelope — the same events the frontend already consumes.
 * @param {{ messages: {role: string, content: string}[], user: object, onToken: (t: string) => void, onDone: (env: object) => void, requestId?: string|null, deps?: object }} opts
 */
export async function streamMessage({ messages, user, onToken, onDone, requestId = null, deps }) {
  const env = await answerTurn({ messages, user, requestId, stream: true, deps });
  onToken(env.reply);
  onDone(env);
}
