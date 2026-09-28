import countCandidates from './countCandidates.tool.js';
import listCandidates from './listCandidates.tool.js';

const instructions = [
  'Candidates: the Candidate role (job seekers in the ATS). Employees are a DIFFERENT role — never answer a ' +
    'candidate question with employee tools or the reverse.',
  '- Candidates are not filtered by employment status; do not say "current candidates".',
  '- One named candidate\'s details → get_user. Their job applications → count_applications/list_applications.',
].join('\n');

const CANDIDATE_NOUN_RE = /\bcandidates?\b/i;

export function matchesTurn(text) {
  return CANDIDATE_NOUN_RE.test(String(text || ''));
}

export default {
  domain: 'candidates',
  instructions,
  tools: [countCandidates, listCandidates],
  matchesTurn,
};
