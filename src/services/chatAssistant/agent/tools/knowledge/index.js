import searchKnowledgeBase from './searchKnowledgeBase.tool.js';

const instructions = [
  'Knowledge base: company policies, FAQs and procedures uploaded to the knowledge base.',
  '- Answer policy / procedure questions ONLY from search_knowledge_base\'s answer. Never add policy details ' +
    'from general knowledge.',
  '- found:false → say the knowledge base has nothing on it (notConfigured → no knowledge base is set up; ' +
    'unavailable → it could not be searched right now). Do not guess.',
  '- Questions about a person\'s own leave balance, attendance, meetings or jobs are data questions for the ' +
    'other tools, not the knowledge base.',
].join('\n');

const KB_RE = /\b(polic(?:y|ies)|handbook|faqs?|knowledge\s*base|code\s+of\s+conduct|sops?|guidelines?|reimburse\w*|notice\s+period|dress\s+code)\b/i;

export function matchesTurn(text) {
  return KB_RE.test(String(text || ''));
}

export default {
  domain: 'knowledge',
  instructions,
  tools: [searchKnowledgeBase],
  matchesTurn,
};
