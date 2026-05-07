import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as chatAssistantService from '../services/chatAssistant.service.js';
import { clearContextCache } from '../services/chatAssistant.service.js';
import * as chatbotConfigService from '../services/chatbotConfig.service.js';
import ConversationMemory from '../models/conversationMemory.model.js';

/**
 * Normalize and validate messages before sending to service/OpenAI
 */
const normalizeMessages = (messages) => {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((m) => ({
      role: m?.role || 'user',
      content: typeof m?.content === 'string' ? m.content.trim() : '',
    }))
    .filter((m) => m.content.length > 0);
};

export const sendMessage = catchAsync(async (req, res) => {
  const cfg = await chatbotConfigService.getConfig(req.user);

  if (!cfg.isGloballyEnabled) {
    return res.status(httpStatus.FORBIDDEN).json({
      success: false,
      message: 'Chatbot is disabled.',
    });
  }

  const messages = normalizeMessages(req.body.messages);

  if (!messages.length) {
    return res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: 'Messages cannot be empty',
    });
  }

  const result = await chatAssistantService.sendMessage({
    messages,
    user: req.user,
  });

  res.status(httpStatus.OK).json({ success: true, data: result });
});

/**
 * SSE streaming endpoint
 */
export const streamMessage = async (req, res) => {
  const cfg = await chatbotConfigService
    .getConfig(req.user)
    .catch(() => ({ isGloballyEnabled: true }));

  if (!cfg.isGloballyEnabled) {
    return res.status(httpStatus.FORBIDDEN).json({
      success: false,
      message: 'Chatbot is disabled.',
    });
  }

  const messages = normalizeMessages(req.body.messages);

  // ❗ Prevent OpenAI empty message error
  if (!messages.length) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error: 'Messages cannot be empty' })}\n\n`);
    return res.end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    await chatAssistantService.streamMessage({
      messages,
      user: req.user,
      onToken: (token) => send({ token }),
      onDone: (envelopePayload) => {
        const payload = { done: true };
        if (envelopePayload && typeof envelopePayload === 'object') {
          if (Array.isArray(envelopePayload.blocks)) payload.blocks = envelopePayload.blocks;
          if (envelopePayload.meta) payload.meta = envelopePayload.meta;
        }
        send(payload);
        res.end();
      },
    });
  } catch (err) {
    send({ error: err?.message || 'Something went wrong' });
    res.end();
  }
};

/**
 * Clear chatbot context cache
 */
export const refreshCache = catchAsync(async (req, res) => {
  const adminId = req.user?.adminId ?? req.user?.id;
  clearContextCache(adminId);

  res.status(httpStatus.OK).json({
    success: true,
    message: 'Context cache cleared',
  });
});

/**
 * Clear chatbot conversation: drop the persisted ConversationMemory row for
 * this user+admin AND bust the per-admin context cache. Frontend invokes
 * this from the "Clear conversation" button so the next turn starts fresh
 * (no summary, no lastEntities, no stale snapshot).
 */
export const clearConversation = catchAsync(async (req, res) => {
  const userId = req.user?.id;
  const adminId = req.user?.adminId ?? userId;
  if (!userId) {
    return res.status(httpStatus.UNAUTHORIZED).json({ success: false, message: 'Unauthorized' });
  }
  const { deletedCount } = await ConversationMemory.deleteOne({ userId, adminId });
  clearContextCache(adminId);
  res.status(httpStatus.OK).json({
    success: true,
    message: 'Conversation cleared',
    deletedMemoryRow: deletedCount > 0,
  });
});

/**
 * Get chatbot settings
 */
export const getSettings = catchAsync(async (req, res) => {
  const data = await chatbotConfigService.getConfig(req.user);

  res.status(httpStatus.OK).json({
    success: true,
    data,
  });
});

/**
 * Update chatbot settings
 */
export const updateSettings = catchAsync(async (req, res) => {
  const { isGloballyEnabled, enabledPages } = req.body;

  const data = await chatbotConfigService.updateConfig(req.user, {
    isGloballyEnabled,
    enabledPages,
  });

  res.status(httpStatus.OK).json({
    success: true,
    data,
  });
});