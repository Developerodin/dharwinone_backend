import Joi from 'joi';
import VoiceAgentModel from '../../../../../models/voiceAgent.model.js';
import { queryKb as realQueryKb } from '../../../../kbQuery.service.js';
import { defineTool } from '../../defineTool.js';

// Same rule as the legacy tool: any signed-in user may ask; the KB is the one owned by the
// viewer's admin (their creator pointer, or themselves when they have none). There is one company,
// so this is not a tenant boundary — it picks which voice agent's KB answers.
export const KNOWLEDGE_ACCESS = Object.freeze({ note: 'any signed-in user; KB of the viewer\'s admin voice agent' });
export const MAX_ANSWER_CHARS = 1200;

function knowledgeDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    // Prefer an agent with its KB switched on — the legacy findOne picked an arbitrary one.
    findVoiceAgent: deps.findVoiceAgent ?? ((createdBy) => VoiceAgentModel.findOne({ createdBy })
      .sort({ knowledgeBaseEnabled: -1, createdAt: 1 })
      .select('_id knowledgeBaseEnabled')
      .lean()),
    queryKb: deps.queryKb ?? realQueryKb,
  };
}

function bound(text) {
  const s = String(text || '').trim();
  return s.length > MAX_ANSWER_CHARS ? `${s.slice(0, MAX_ANSWER_CHARS)}…` : s;
}

export default defineTool({
  name: 'search_knowledge_base',
  domain: 'knowledge',
  kind: 'read',
  description:
    'Answer a company policy / FAQ / procedure question from the company knowledge base (uploaded HR ' +
    'policies, onboarding docs, FAQs). Use for "what is the leave policy", "how do I claim reimbursement", ' +
    '"what is the notice period". Returns a short answer written only from the KB; found:false means the KB ' +
    'has nothing on it.',
  input: Joi.object({
    query: Joi.string().min(2).max(500).required().description('The question, in the user\'s words.'),
  }),
  access: KNOWLEDGE_ACCESS,
  async execute({ query } = {}, ctx) {
    const user = ctx?.user;
    const ownerId = user?.adminId || user?.id || user?._id;
    if (!ownerId) throw new Error('search_knowledge_base needs an authenticated user with an id');
    const deps = knowledgeDeps(ctx);
    const agent = await deps.findVoiceAgent(ownerId);
    if (!agent) return { found: false, notConfigured: true, answer: null };
    try {
      const res = await deps.queryKb(String(agent._id), query);
      if (res?.fallback) return { found: false, answer: null };
      return { found: true, answer: bound(res?.answer) };
    } catch (err) {
      return { found: false, unavailable: true, answer: null, reason: String(err?.message || err).slice(0, 200) };
    }
  },
});
