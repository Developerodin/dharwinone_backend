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

export default {
  domain: 'knowledge',
  summary: 'Company policies and FAQs from the knowledge base (leave policy, notice period, benefits, procedures).',
  instructions,
  tools: [searchKnowledgeBase],
};
