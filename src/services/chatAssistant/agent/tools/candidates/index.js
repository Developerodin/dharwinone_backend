import countCandidates from './countCandidates.tool.js';
import listCandidates from './listCandidates.tool.js';
import matchCandidatesToJob from './matchCandidatesToJob.tool.js';

const instructions = [
  'Candidates: the Candidate role (job seekers in the ATS). Employees are a DIFFERENT role — never answer a ' +
    'candidate question with employee tools or the reverse.',
  '- count_candidates/list_candidates only include profiles whose account is active or pending; disabled and ' +
    'deleted accounts are excluded, so they can be lower than the Users page. For a candidate count across every ' +
    'account status ("in total", "all candidates in total", "including inactive") use count_users with filters.role ' +
    '"Candidate" and filters.status "all". Never claim the candidate count ignores account status.',
  '- Candidates have no current/resigned split; do not say "current candidates".',
  '- One named candidate\'s details → get_user. Their job applications → count_applications/list_applications.',
  '- "Who fits / best candidates for <job>" → match_candidates_to_job directly with jobTitle (or a jobId already ' +
    'in the conversation). Do not look the job up with a job tool first. It ranks by fit; it is not a count of everyone qualified. "Which employees ' +
    'could move into <job>" → pool "employees". People who APPLIED to a job are list_applications, not this.',
].join('\n');

export default {
  domain: 'candidates',
  summary: 'Candidate-role profiles: counts and lists, and ranking candidates or employees against a job.',
  instructions,
  tools: [countCandidates, listCandidates, matchCandidatesToJob],
};
