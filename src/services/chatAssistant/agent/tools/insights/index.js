import getAttentionDigest from './getAttentionDigest.tool.js';
import getOperationsSummary from './getOperationsSummary.tool.js';
import runDataQualityChecks from './runDataQualityChecks.tool.js';

const instructions = [
  'Insights: cross-module composites built from the other domains\' tools, each section under your own access.',
  '- "What needs my attention", "today\'s exceptions", "critical alerts", "who needs follow-up", Monday briefing, ' +
    'end-of-day report -> get_attention_digest ("my" -> scope mine; "since yesterday", "this month vs last" -> ' +
    'compareTo previous with the matching window).',
  '- "Recruitment / HR / PM / bench summary or report" -> get_operations_summary with that module.',
  '- "Data quality", "missing data", "incomplete records", "duplicates" -> run_data_quality_checks.',
  '- Each section has a status. Name restricted sections only, never their data, and never fill one from ' +
    'another tool. notCaptured -> say it is not captured in DharwinOne. unavailable -> say the note and do not ' +
    'invent a count. Overdue training is unavailable because no due date is stored; last access and enrollment ' +
    'are not overdue. Backlog items are the current state; only windowed items follow the window.',
  '- One number in one module (e.g. "how many offers") is that domain\'s count tool, not insights.',
].join('\n');

export default {
  domain: 'insights',
  summary: 'What needs attention today, exceptions, what changed, module summaries, data quality checks',
  instructions,
  tools: [getAttentionDigest, getOperationsSummary, runDataQualityChecks],
};
