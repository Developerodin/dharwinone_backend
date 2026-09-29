import countJobs from './countJobs.tool.js';
import listJobs from './listJobs.tool.js';
import getJob from './getJob.tool.js';
import rankJobsBySalary from './rankJobsBySalary.tool.js';
import { hasJobSubjectNoun } from '../../../queryPlanner/entities/jobFilter.js';
import { looksLikeJobRankingQuery } from '../../../queryPlanner/entities/jobRank.js';

const instructions = [
  'Jobs: job postings on the ATS Jobs page, internal openings and mirrored external listings.',
  '- "each/per/by X" or "breakdown by X" → count_jobs with groupBy X. If X is not one of the groupBy ' +
    'values, say jobs have no such field and name the ones that exist instead of guessing.',
  '- A technology or topic word ("react jobs", "python jobs") → filters.search. Use filters.skill only when ' +
    'the user explicitly asks for a required skill tag.',
  '- Several topics at once ("ml and ai jobs") → one call with filters.search as an array: ["ml", "ai"].',
  '- Jobs needing several things at once ("react and node jobs") → filters.searchAll: ["react", "node"].',
  '- Stack acronyms (MERN, MEAN, LAMP) are rarely written in postings. Query the stack\'s core parts with ' +
    'searchAll instead — MERN → ["react", "node"], MEAN → ["angular", "node"] — and say which terms you matched ' +
    '(e.g. "jobs mentioning both React and Node"). Never answer 0 from the acronym alone.',
  '- Status defaults to Active. "Open" jobs are Active jobs, so pass no status for them. When you did not ' +
    'pass a status, say the numbers are for active jobs.',
  '- A specific job by id or title → get_job. If it returns matches, ask which one the user meant.',
  '- External / mirrored / LinkedIn jobs → filters.jobOrigin "external"; a named feed (LinkedIn) → also ' +
    'filters.externalSource. The raw External Jobs search page is not visible to you — only mirrored listings.',
  '- Who fits a job / best candidates for a job → match_candidates_to_job, not a job tool.',
  '- Highest/lowest paying → rank_jobs_by_salary. Listing jobs → list_jobs; its total is the full count ' +
    'even when fewer rows come back.',
  '- A short follow-up that\'s just a person\'s name ("what about John", "and Priya?") is not a job filter, ' +
    'even right after a job answer — call handoff instead of putting the name into search, company, or any ' +
    'other filter.',
].join('\n');

export default {
  domain: 'jobs',
  instructions,
  // Gate test for agent/gate.js's matchedDomains: the noun/ranking-query test the
  // gate used to hard-code.
  matchesTurn: (text) => hasJobSubjectNoun(text) || looksLikeJobRankingQuery(text),
  tools: [countJobs, listJobs, getJob, rankJobsBySalary],
};
