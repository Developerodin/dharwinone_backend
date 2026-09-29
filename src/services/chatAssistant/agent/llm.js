// Model adapter for Sage's agent loop (architecture.md §4) — the ONLY file that
// knows the provider. Today: OpenAI Responses API (chat.completions rejects
// function tools with reasoning on our model). Switching provider/model = this file.
//
// Stateless on OpenAI's side (`store:false`): the caller appends `outputItems`
// (reasoning + function_call items, verbatim) to the next step's `input`, and
// `include:['reasoning.encrypted_content']` makes any reasoning item replayable.

import config from '../../../config/config.js';

/**
 * One model step.
 *
 * @param {object} args
 * @param {{responses:{create:Function}}} args.client OpenAI client (caller constructs it)
 * @param {string} args.instructions stable prefix
 * @param {Array} args.input
 * @param {Array} args.tools Responses-format function tool schemas
 * @param {'auto'|'none'} [args.toolChoice]
 * @param {number} [args.maxOutputTokens]
 * @param {number} [args.timeoutMs] per-request timeout; defaults to chatbot.agent.stepTimeoutMs
 * @returns {Promise<{status:string|null, text:string, toolCalls:Array<{callId:string,name:string,arguments:string}>, outputItems:Array, usage:object|null}>}
 *   Provider errors propagate — the loop owns the fallback.
 */
export async function step({
  client,
  instructions,
  input,
  tools,
  toolChoice = 'auto',
  maxOutputTokens = 6000,
  timeoutMs = config.chatbot.agent.stepTimeoutMs,
}) {
  // SDK defaults are a 10-minute timeout with 2 retries; the agent must fail fast
  // so the user still gets the fixed fallback reply in time. No retries.
  const res = await client.responses.create({
    model: config.chatbot.model,
    instructions,
    input,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    reasoning: { effort: config.chatbot.reasoningEffort },
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: maxOutputTokens,
  }, { timeout: timeoutMs, maxRetries: 0 });

  const outputItems = Array.isArray(res?.output) ? res.output : [];
  const toolCalls = outputItems
    .filter((item) => item?.type === 'function_call')
    .map((item) => ({ callId: item.call_id, name: item.name, arguments: item.arguments }));

  // `incomplete` (e.g. max_output_tokens hit) carries a truncated output_text —
  // never a finished answer. Report it as empty so the loop retries or falls back.
  const status = res?.status ?? null;
  return {
    status,
    text: status === 'incomplete' ? '' : (res?.output_text ?? ''),
    toolCalls,
    outputItems,
    usage: res?.usage ?? null,
  };
}
