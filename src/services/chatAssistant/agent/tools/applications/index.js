import countApplications from './countApplications.tool.js';
import listApplications from './listApplications.tool.js';

const instructions = [
  'Applications: job applications (a person applying to a job posting).',
  '- "he", "she", "they", "this user", "this person" in a follow-up mean the person from the previous turn. ' +
    'Put that person\'s real name in filters.applicantName (or their id in applicantUserId). Never pass the ' +
    'pronoun itself. If no person was discussed, ask which person.',
  '- "How many jobs has X applied to" → count_applications. "Which jobs" → list_applications.',
  '- If a result has notFound "applicant", say you could not find that person\'s applications — not "0 jobs".',
].join('\n');

const APPLICATION_RE = /\b(appl(?:y|ied|ies|ying)|applications?|applicants?)\b/i;

export function matchesTurn(text) {
  return APPLICATION_RE.test(String(text || ''));
}

export default {
  domain: 'applications',
  instructions,
  tools: [countApplications, listApplications],
  matchesTurn,
};
