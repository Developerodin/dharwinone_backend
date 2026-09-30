import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { resolveJobByTitle } from '../../../jobProfile/resolveJobByTitle.js';
import { andMongoFilters, buildJobRankingMongoFilter, scopeJobModel } from '../../../queryPlanner/entities/jobRank.js';
import { filters, withDefaultStatus } from './filters.js';
import { JOBS_ACCESS, jobScope } from './common.js';
import {
  STATS_JOB_SELECT, RANKERS, TIME_TO_FILL_BASIS, INTERVIEWED_BASIS, HIRED_BASIS, jobStatsDeps, recentCutoff, applicationsByJob, rankedRow,
  singleJobStats,
} from './jobStats.js';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DEFAULT_RECENT_DAYS = 14;
// Applications are counted by one grouped query (applicantQuery.service aggregateApplicationsByJob), so the
// only per-job cost left is reading each matching job's few ranking fields.
// ponytail: ceiling of matching jobs ranked (newest first; oldest first for oldest_open). Past it, results
// say so; the upgrade is ranking inside one Job aggregate with the application counts $lookup'd in.
export const POOL_MAX = 5000;

const COUNT_BASIS =
  'Applications you can see (your application scope), one per person per job — repeat applications by the same ' +
  'person are dropped, the same count the Job analytics page shows.';

async function loadJob(Job, visibilityFilter, jobId) {
  return Job.findOne(andMongoFilters({ _id: jobId }, visibilityFilter)).select(STATS_JOB_SELECT).lean();
}

export default defineTool({
  name: 'get_job_stats',
  domain: 'jobs',
  kind: 'read',
  description:
    'Hiring stats for job postings. With jobId or title: one job\'s applications and stage breakdown, last ' +
    'application date, whether it has zero applications / none in the last N days / applications but no ' +
    'interviews, openings left, hire rate, time-to-fill and a close suggestion. Without them: ranks the jobs you ' +
    'can see by rankBy — most/fewest applications, zero applications, no recent applications, applications but ' +
    'no interviews, openings left, oldest open, jobs you may want to close, hire rate, time-to-fill.',
  measure:
    'Job POSTINGS you can see on the ATS Jobs page (status Active unless filters.status is set) and the ' +
    'job APPLICATIONS your application scope shows for them.',
  input: Joi.object({
    jobId: Joi.string().description('One job\'s id (from an earlier job row). Gives that job\'s stats.'),
    title: Joi.string().min(1).max(200).description('One job\'s title or part of it. Gives that job\'s stats.'),
    rankBy: Joi.string()
      .valid(...Object.keys(RANKERS))
      .default('applications')
      .description(
        'Ranking across jobs when no jobId/title is given. applications / fewest_applications; zero_applications; ' +
          'no_recent_applications (none in the last noApplicationsInDays days); no_interviews (applications but none ' +
          'interviewed — no interview scheduled or held and nobody at Interview, Offered or Hired); vacancies_left; oldest_open; close_candidates (openings filled or deadline ' +
          'passed — a suggestion); hire_rate; time_to_fill (fastest first).',
      ),
    noApplicationsInDays: Joi.number().integer().min(1).max(365).default(DEFAULT_RECENT_DAYS)
      .description('N for "no applications in the last N days" (whole IST days including today).'),
    filters,
    limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
      .description(`Max ranked rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). total is always the full count.`),
  }),
  access: JOBS_ACCESS,
  async execute(args = {}, ctx) {
    const { Job, visibilityFilter } = await jobScope(ctx);
    const deps = jobStatsDeps(ctx);
    const now = deps.now();
    const days = args.noApplicationsInDays || DEFAULT_RECENT_DAYS;
    const cutoff = recentCutoff(days, now);

    if (args.jobId || args.title) {
      let job = args.jobId && OBJECT_ID_RE.test(args.jobId) ? await loadJob(Job, visibilityFilter, args.jobId) : null;
      if (!job && args.title) {
        const resolved = await resolveJobByTitle(args.title, { Job, visibilityFilter });
        if (resolved.kind === 'ambiguous') return { matches: resolved.matches };
        if (resolved.kind === 'unique') job = await loadJob(Job, visibilityFilter, resolved.job.jobId);
      }
      if (!job) return { notFound: true };
      const id = String(job._id);
      const [stats, apps, hiredMap] = await Promise.all([
        deps.getJobStats(id, ctx.user),
        applicationsByJob({ jobId: id }, ctx.user, deps),
        deps.hireFactsForJobs([id]),
      ]);
      return singleJobStats(job, stats, apps.get(id), hiredMap.get(id), { now, days, cutoff });
    }

    const rankBy = args.rankBy || 'applications';
    const limit = Math.min(args.limit || DEFAULT_LIMIT, MAX_LIMIT);
    const filtersApplied = withDefaultStatus(args.filters);
    const scoped = scopeJobModel(Job, visibilityFilter);
    const mongoFilter = buildJobRankingMongoFilter({ filters: filtersApplied });
    const [jobsMatchingFilters, pool] = await Promise.all([
      scoped.countDocuments(mongoFilter),
      scoped.find(mongoFilter)
        .select(STATS_JOB_SELECT)
        .sort({ createdAt: rankBy === 'oldest_open' ? 1 : -1 })
        .limit(POOL_MAX)
        .lean(),
    ]);
    const ids = pool.map((j) => String(j._id));
    const [apps, hiredMap] = await Promise.all([
      ids.length ? applicationsByJob({ jobIds: ids }, ctx.user, deps) : new Map(),
      ids.length ? deps.hireFactsForJobs(ids) : new Map(),
    ]);
    const ranker = RANKERS[rankBy];
    const rows = pool
      .map((j) => rankedRow(j, apps.get(String(j._id)), hiredMap.get(String(j._id)), now))
      .filter((r) => (ranker.keep ? ranker.keep(r, cutoff) : true))
      .sort(ranker.sort);

    return {
      rankBy,
      total: rows.length,
      jobs: rows.slice(0, limit),
      jobsConsidered: pool.length,
      jobsMatchingFilters,
      ...(pool.length < jobsMatchingFilters
        ? { poolNote: `Only ${POOL_MAX} of ${jobsMatchingFilters} matching jobs were checked; narrow the filters for the rest.` }
        : {}),
      ...(rankBy === 'no_recent_applications' ? { noApplicationsInDays: days } : {}),
      ...(rankBy === 'close_candidates'
        ? { suggestion: 'Suggestions only — nothing is closed automatically from here.' }
        : {}),
      ...(rankBy === 'time_to_fill' ? { timeToFillBasis: TIME_TO_FILL_BASIS } : {}),
      ...(rankBy === 'no_interviews' ? { interviewedBasis: INTERVIEWED_BASIS } : {}),
      countBasis: COUNT_BASIS,
      hiredBasis: HIRED_BASIS,
      filtersApplied,
    };
  },
  render(result) {
    if (!result?.jobs?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'job-stats',
        tableType: 'job-stats',
        title: `Jobs by ${result.rankBy.replace(/_/g, ' ')} (${result.total})`,
        columns: [
          { key: 'title', label: 'Job', priority: 'primary' },
          { key: 'applications', label: 'Applications', priority: 'primary', format: 'number' },
          { key: 'interviewed', label: 'Interviewed', priority: 'secondary', format: 'number' },
          { key: 'vacanciesLeft', label: 'Openings left', priority: 'secondary' },
          { key: 'daysOpen', label: 'Days open', priority: 'secondary' },
        ],
        rows: result.jobs.map((r) => ({
          title: r.title ?? '—',
          applications: String(r.applications),
          interviewed: String(r.interviewed),
          vacanciesLeft: r.vacanciesLeft == null ? '—' : String(r.vacanciesLeft),
          daysOpen: r.daysOpen == null ? '—' : String(r.daysOpen),
        })),
        layout: 'auto',
      }],
    };
  },
});
