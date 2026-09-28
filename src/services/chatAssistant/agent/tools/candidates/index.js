import countCandidates from './countCandidates.tool.js';
import listCandidates from './listCandidates.tool.js';

const instructions = [
  'Candidates: the Candidate role (job seekers in the ATS). Employees are a DIFFERENT role — never answer a ' +
    'candidate question with employee tools or the reverse.',
  '- count_candidates/list_candidates only include profiles whose account is active or pending; disabled and ' +
    'deleted accounts are excluded, so they can be lower than the Users page. For a candidate count across every ' +
    'account status ("in total", "all candidates in total", "including inactive") use count_users with filters.role ' +
    '"Candidate" and filters.status "all". Never claim the candidate count ignores account status.',
  '- Candidates have no current/resigned split; do not say "current candidates".',
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
