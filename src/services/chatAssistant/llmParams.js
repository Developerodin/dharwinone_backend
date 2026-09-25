/**
 * Chat-completions params for Sage's model (config.chatbot.model / CHATBOT_MODEL).
 *
 * gpt-5+/gpt-6 and o-series reject `max_tokens` and any non-default `temperature`,
 * and on /v1/chat/completions only accept function tools with reasoning_effort
 * 'none' (verified against gpt-6-luna, 2026-09-25). 'none' also keeps router
 * latency near gpt-4o-mini. Older gpt-4* models keep their original params.
 */
const isReasoningModel = (model) => /^(gpt-[5-9]|o\d)/i.test(String(model || ''));

export function llmParams(model, { temperature, maxTokens } = {}) {
  if (isReasoningModel(model)) {
    return { model, max_completion_tokens: maxTokens, reasoning_effort: 'none' };
  }
  return { model, temperature, max_tokens: maxTokens };
}
