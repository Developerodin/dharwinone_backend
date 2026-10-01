import countApplications from './countApplications.tool.js';
import listApplications from './listApplications.tool.js';

const instructions = [
  'Applications: job applications (a person applying to a job posting).',
  '- "he", "she", "they", "this user", "this person" in a follow-up mean the person from the previous turn. ' +
    'Put that person\'s real name in filters.applicantName (or their id in applicantUserId). Never pass the ' +
    'pronoun itself. If no person was discussed, ask which person.',
  '- When the person\'s name is already in the conversation, call the application tool directly with it — ' +
    'do not look the person up with get_user first.',
  '- "How many jobs has X applied to" → count_applications. "Which jobs" → list_applications.',
  '- If a result has notFound "applicant", say you could not find that person\'s applications — not "0 jobs".',
  '- "How long in the current status" / "stuck more than N days" → filters.inStatusOverDays = N (more than N ' +
    'whole IST days). daysInStatus counts from the last statusHistory entry. Null means status history is not ' +
    'recorded — say so, and never use appliedAt or createdAt as a substitute. statusAgeUnknown is that count.',
  '- daysToScreening and daysScreeningToInterview are set only when status history is complete (stageDateBasis ' +
    '"history"). Otherwise they are null — not captured. Do not estimate them.',
  '- "Screened but never interviewed" / "successfully screened" → filters.screenedNeverInterviewed true. ' +
    'Screened means the status history contains Screening. screeningUnknown is applications with no history: ' +
    'do not call them screened or not screened. Say that count separately.',
].join('\n');

export default {
  domain: 'applications',
  summary: 'Job applications by applicant, job or status, days in status, and screened but never interviewed.',
  instructions,
  tools: [countApplications, listApplications],
};
