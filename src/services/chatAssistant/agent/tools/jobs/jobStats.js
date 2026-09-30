import JobApplicationModel from '../../../../../models/jobApplication.model.js';
import OfferModel from '../../../../../models/offer.model.js';
import { getJobStats as realGetJobStats } from '../../../../job.service.js';
import { aggregateApplicationsByJob as realAggregateApplicationsByJob } from '../../../../applicantQuery.service.js';
import { isVacancyCapacityFull } from '../../../../../constants/atsPipeline.js';
import { dateStrInTz, addDaysToDateStr } from '../../../../../utils/zonedTime.js';
import { DEFAULT_TIMEZONE } from '../../context.js';
import { dayWindowBounds } from '../employees/common.js';

export const STATS_JOB_SELECT = 'title status createdAt vacancies applicationDeadline organisation';
const DAY_MS = 24 * 60 * 60 * 1000;

export const TIME_TO_FILL_BASIS =
  'Days from posting to the day the last opening was filled, only once every opening is filled. A hire\'s ' +
  'date is when its offer was accepted; a hire made without an offer (e.g. an internal transfer) uses the ' +
  'application\'s last update.';

export const HIRED_BASIS =
  'hired / vacanciesLeft count every hire on the job (the Jobs page "filled" badge); applications and ' +
  'hireRatePercent count only the applications you can see, so hired can be higher than the Hired stage.';

export const INTERVIEWED_BASIS =
  'An application counts as interviewed when it has a scheduled or held interview (not cancelled) or sits at ' +
  'Interview, Offered or Hired.';

/**
 * Hired count and last fill date per job, in one aggregation. The count is the same match as
 * job.service getHiredCountsForJobs (every Hired application on the job — the number the vacancy guard
 * and the Jobs page "filled" badge use). The fill date is the accepted offer's acceptedAt, the moment
 * offer.service flips the application to Hired; only an offer-less hire falls back to updatedAt, which
 * any later edit moves.
 * @param {string[]} jobIds
 * @param {{ JobApplication: object, Offer: object }} models
 * @returns {Promise<Map<string, { hired: number, lastHiredAt: Date|null, hiredFromOffers: number }>>}
 */
export async function hireFactsForJobs(jobIds, { JobApplication, Offer }) {
  if (!jobIds.length) return new Map();
  const rows = await JobApplication.aggregate([
    { $match: JobApplication.find({ job: { $in: jobIds }, status: 'Hired' }).cast() },
    {
      $lookup: {
        from: Offer.collection.collectionName,
        let: { app: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$jobApplication', '$$app'] }, status: 'Accepted' } },
          { $project: { acceptedAt: 1 } },
        ],
        as: '_offers',
      },
    },
    { $set: { _acceptedAt: { $max: '$_offers.acceptedAt' } } },
    {
      $group: {
        _id: '$job',
        hired: { $sum: 1 },
        lastHiredAt: { $max: { $ifNull: ['$_acceptedAt', '$updatedAt'] } },
        hiredFromOffers: { $sum: { $cond: [{ $eq: [{ $type: '$_acceptedAt' }, 'date'] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [
    String(r._id),
    { hired: r.hired, lastHiredAt: r.lastHiredAt ?? null, hiredFromOffers: r.hiredFromOffers },
  ]));
}

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function jobStatsDeps(ctx) {
  const d = ctx?.deps || {};
  const models = { JobApplication: d.JobApplication ?? JobApplicationModel, Offer: d.Offer ?? OfferModel };
  return {
    getJobStats: d.getJobStats ?? realGetJobStats,
    aggregateApplicationsByJob: d.aggregateApplicationsByJob ?? realAggregateApplicationsByJob,
    hireFactsForJobs: d.hireFactsForJobs ?? ((ids) => hireFactsForJobs(ids, models)),
    now: d.now ?? (() => new Date()),
  };
}

/** Whole IST calendar days from `from` to `to` (yesterday 23:00 → today 01:00 is 1 day, not 0). */
export const daysBetween = (from, to) => {
  if (!from || !to) return null;
  const day = (d) => Date.parse(`${dateStrInTz(new Date(d), DEFAULT_TIMEZONE)}T00:00:00Z`);
  return Math.round((day(to) - day(from)) / DAY_MS);
};
const round1 = (n) => Math.round(n * 10) / 10;

/** Start of "the last N days" in IST: local midnight of today − (N − 1), like every other day window. */
export function recentCutoff(days, now) {
  const today = dateStrInTz(now, DEFAULT_TIMEZONE);
  return new Date(dayWindowBounds({ from: addDaysToDateStr(today, -(days - 1)) }).from);
}

/**
 * Openings, hires and time-to-fill for one job, from hireFactsForJobs. A lean job with no `vacancies`
 * is uncapped (legacy), so vacanciesLeft is null there, not 0.
 */
export function vacancyFacts(job, hiredRow) {
  const vacancies = job?.vacancies ?? null;
  const hired = hiredRow?.hired ?? 0;
  const filled = vacancies != null && isVacancyCapacityFull(hired, vacancies);
  return {
    vacancies,
    hired,
    vacanciesLeft: vacancies == null ? null : Math.max(vacancies - hired, 0),
    timeToFillDays: filled && hiredRow?.lastHiredAt ? daysBetween(job.createdAt, hiredRow.lastHiredAt) : null,
  };
}

/** A suggestion, never an action: only Active jobs whose openings are filled or whose deadline has passed. */
export function closeSuggestion(job, facts, now) {
  if (job?.status !== 'Active') return null;
  if (facts.vacanciesLeft === 0) return 'Every opening is filled — you may want to close this job.';
  if (job.applicationDeadline && new Date(job.applicationDeadline) < now) {
    return 'The application deadline has passed — you may want to close this job.';
  }
  return null;
}

export const hireRate = (hired, total) => (total > 0 ? round1((hired / total) * 100) : null);

/**
 * Applications per job id under the viewer's application scope, one per person per job — the
 * Job analytics page's count (applicantQuery.service aggregateApplicationsByJob).
 * @returns {Promise<Map<string, { total: number, byStage: object, lastAppliedAt: Date|null, interviewed: number }>>}
 */
export async function applicationsByJob(filter, user, deps) {
  const rows = await deps.aggregateApplicationsByJob(filter, user);
  return new Map((rows || []).map((r) => [String(r.jobId), r]));
}

const EMPTY_APPS = Object.freeze({ total: 0, byStage: {}, lastAppliedAt: null, interviewed: 0 });

/** One ranked row: compact, no stage breakdown (the single-job view has that). */
export function rankedRow(job, apps, hiredRow, now) {
  const a = apps || EMPTY_APPS;
  const v = vacancyFacts(job, hiredRow);
  return {
    jobId: String(job._id),
    title: job.title ?? null,
    company: job.organisation?.name ?? null,
    status: job.status ?? null,
    createdAt: job.createdAt ?? null,
    daysOpen: daysBetween(job.createdAt, now),
    applications: a.total,
    interviewed: a.interviewed,
    lastApplicationAt: a.lastAppliedAt,
    hireRatePercent: hireRate(a.byStage?.Hired || 0, a.total),
    ...v,
    closeSuggestion: closeSuggestion(job, v, now),
  };
}

const byCreatedAsc = (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
const byLastAppAsc = (a, b) => new Date(a.lastApplicationAt || 0) - new Date(b.lastApplicationAt || 0);

/** rankBy → which rows qualify and in what order. */
export const RANKERS = Object.freeze({
  applications: { sort: (a, b) => b.applications - a.applications },
  fewest_applications: { sort: (a, b) => a.applications - b.applications },
  zero_applications: { keep: (r) => r.applications === 0, sort: byCreatedAsc },
  no_recent_applications: {
    keep: (r, cutoff) => !r.lastApplicationAt || new Date(r.lastApplicationAt) < cutoff,
    sort: byLastAppAsc,
  },
  no_interviews: { keep: (r) => r.applications > 0 && r.interviewed === 0, sort: (a, b) => b.applications - a.applications },
  vacancies_left: { keep: (r) => r.vacanciesLeft > 0, sort: (a, b) => b.vacanciesLeft - a.vacanciesLeft },
  oldest_open: { keep: (r) => r.status === 'Active', sort: byCreatedAsc },
  close_candidates: { keep: (r) => !!r.closeSuggestion, sort: byCreatedAsc },
  hire_rate: { keep: (r) => r.hireRatePercent != null, sort: (a, b) => b.hireRatePercent - a.hireRatePercent },
  time_to_fill: { keep: (r) => r.timeToFillDays != null, sort: (a, b) => a.timeToFillDays - b.timeToFillDays },
});

/**
 * Single-job stats: getJobStats (the Job analytics page, viewer-scoped funnel) + the interviewed count
 * from the same scoped grouping + job-level vacancy facts.
 */
export function singleJobStats(job, stats, apps, hiredRow, { now, days, cutoff }) {
  const byStage = Object.fromEntries((stats.funnel || []).map((f) => [f.status, f.count]));
  const total = stats.totalApplications ?? 0;
  const lastAt = stats.recentApplications?.[0]?.appliedAt ?? null;
  const interviewed = apps?.interviewed ?? 0;
  const v = vacancyFacts(job, hiredRow);
  return {
    job: {
      jobId: String(job._id),
      title: job.title ?? null,
      company: job.organisation?.name ?? null,
      status: job.status ?? null,
      createdAt: job.createdAt ?? null,
      daysOpen: daysBetween(job.createdAt, now),
      applicationDeadline: job.applicationDeadline ?? null,
    },
    applications: {
      total,
      byStage,
      interviewed,
      lastApplicationAt: lastAt,
      daysSinceLastApplication: daysBetween(lastAt, now),
    },
    zeroApplications: total === 0,
    noApplicationsInLastDays: { days, none: !lastAt || new Date(lastAt) < cutoff },
    applicationsButNoInterviews: total > 0 && interviewed === 0,
    interviewedBasis: INTERVIEWED_BASIS,
    hireRatePercent: hireRate(byStage.Hired || 0, total),
    ...v,
    hiredBasis: HIRED_BASIS,
    timeToFillBasis: TIME_TO_FILL_BASIS,
    closeSuggestion: closeSuggestion(job, v, now),
  };
}
