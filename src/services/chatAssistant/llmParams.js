/**
 * Chat-completions params for Sage's model (config.chatbot.model / CHATBOT_MODEL).
 *
 * gpt-5+/gpt-6 and o-series reject `max_tokens` and any non-default `temperature`,
 * and on /v1/chat/completions only accept function tools with reasoning_effort
 * 'none' (verified 2026-09-25) — so calls that send tools must leave reasoningEffort
 * unset. Calls without tools may pass CHATBOT_REASONING_EFFORT.
 * Older gpt-4* models keep their original params.
 */
const isReasoningModel = (model) => /^(gpt-[5-9]|o\d)/i.test(String(model || ''));

// Reasoning tokens are billed against max_completion_tokens; without headroom a long
// think can use the whole budget and return an empty reply.
// ponytail: flat headroom, size it per effort if replies still truncate.
const REASONING_HEADROOM_TOKENS = 4000;

export function llmParams(model, { temperature, maxTokens, reasoningEffort = 'none' } = {}) {
  if (isReasoningModel(model)) {
    const effort = reasoningEffort || 'none';
    const budget = effort === 'none' || maxTokens == null ? maxTokens : maxTokens + REASONING_HEADROOM_TOKENS;
    return { model, max_completion_tokens: budget, reasoning_effort: effort };
  }
  return { model, temperature, max_tokens: maxTokens };
}
