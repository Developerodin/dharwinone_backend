import countJobs from './countJobs.tool.js';
import listJobs from './listJobs.tool.js';
import getJob from './getJob.tool.js';
import rankJobsBySalary from './rankJobsBySalary.tool.js';

const instructions = [
  'Jobs: job postings on the ATS Jobs page, internal openings and mirrored external listings.',
  '- "each/per/by X" or "breakdown by X" → count_jobs with groupBy X. If X is not one of the groupBy ' +
    'values, say jobs have no such field and name the ones that exist instead of guessing.',
  '- Several topics at once ("ml and ai jobs") → one call with filters.search as an array: ["ml", "ai"].',
  '- Jobs needing several things at once ("react and node jobs") → filters.searchAll: ["react", "node"].',
  '- Stack acronyms (MERN, MEAN, LAMP) are rarely written in postings. Query the stack\'s core parts with ' +
    'searchAll instead — MERN → ["react", "node"], MEAN → ["angular", "node"] — and say which terms you matched ' +
    '(e.g. "jobs mentioning both React and Node"). Never answer 0 from the acronym alone.',
  '- Status defaults to Active. When you did not pass a status, say the numbers are for active jobs.',
  '- A specific job by id or title → get_job. If it returns matches, ask which one the user meant.',
  '- Highest/lowest paying → rank_jobs_by_salary. Listing jobs → list_jobs; its total is the full count ' +
    'even when fewer rows come back.',
  '- A short follow-up that\'s just a person\'s name ("what about John", "and Priya?") is not a job filter, ' +
    'even right after a job answer — call handoff instead of putting the name into search, company, or any ' +
    'other filter.',
].join('\n');

export default {
  domain: 'jobs',
  instructions,
  tools: [countJobs, listJobs, getJob, rankJobsBySalary],
};
