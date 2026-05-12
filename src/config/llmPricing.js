/**
 * OpenAI per-1M-token pricing as of 2026-05.
 * Update when pricing changes.
 */
export const LLM_PRICING_USD_PER_M = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

export function costForUsage(model, usage) {
  const p = LLM_PRICING_USD_PER_M[model];
  if (!p || !usage) return 0;
  const inUsd = ((usage.prompt_tokens || 0) / 1000000) * p.input;
  const outUsd = ((usage.completion_tokens || 0) / 1000000) * p.output;
  return Number((inUsd + outUsd).toFixed(6));
}
