/**
 * Shared sync logic for the External Jobs auto-fetcher. Both the scheduler tick
 * (externalJobAutoFetch.scheduler.js) and the manual "Fetch Now" API call this
 * SAME function -- there is exactly one sync implementation.
 *
 * Design decision (documented per the product spec's explicit requirement):
 * auto-fetched jobs are written DIRECTLY to the published `Job` model via the
 * existing syncPublishedJobForExternal(), never through `ExternalJob`.
 * `ExternalJob` is schema-required `savedBy: ObjectId` -- a real user's bookmark,
 * not a shared cache -- and a scheduled pull has no natural user. Inventing a
 * fake bot account to satisfy that constraint was the thing explicitly ruled
 * out. `syncPublishedJobForExternal` already dedupes purely on
 * `Job.externalRef.{externalId,source}` (via findMirroredJobByRef) and doesn't
 * require a real ExternalJob document (confirmed: `extDoc.toObject?.() || extDoc`
 * tolerates a plain object) -- so reusing it needs zero changes to ExternalJob's
 * user-owned semantics. `Job.createdBy` for these jobs is the config's own
 * `createdBy` (the admin who set up the auto-fetch) -- real provenance, not a
 * fabricated identity. Manually-saved jobs are completely unaffected: they still
 * go through ExternalJob/saveJob() exactly as before.
 *
 * Staleness scope: Job.autoFetchConfigId + Job.lastSeenAt (added to the Job
 * schema for this feature). A job is only eligible for archival if it belongs
 * to THIS config (autoFetchConfigId matches) and wasn't re-discovered in the
 * run that just completed (lastSeenAt older than this run's start). Manually
 * saved jobs have autoFetchConfigId: null and are never touched. Jobs from a
 * different config have a different autoFetchConfigId and are never touched.
 *
 * Safety: the stale sweep only runs when the sync status is 'completed' (every
 * query succeeded). A 'partial' run (some title/location queries failed) or a
 * 'failed' run (all of them failed) never archives anything -- a query that
 * couldn't reach the provider is not evidence a job disappeared.
 */
import ExternalJobAutoFetchConfig from '../models/externalJobAutoFetchConfig.model.js';
import ExternalJobSyncRun from '../models/externalJobSyncRun.model.js';
import Job from '../models/job.model.js';
import externalJobService from './externalJob.service.js';
import { syncPublishedJobForExternal } from './externalJobPublishedJob.service.js';
import logger from '../config/logger.js';

// externalJob.service.js enforces 5 requests/minute per rate-limit key. Spacing
// queries at this interval keeps a multi-title x multi-location run under that
// limit without a queue library -- ponytail: this is the whole throttle.
// Env-overridable so tests don't burn 13s+ per multi-query run for real.
const RATE_LIMIT_DELAY_MS = Number(process.env.AUTO_FETCH_RATE_LIMIT_DELAY_MS) || 13 * 1000;
/** Distinct rate-limit bucket so scheduled/manual sync runs never compete with a real user's interactive search. */
const SYSTEM_RATE_LIMIT_KEY = 'auto-fetch-system';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Schema supports multiple configs; the product currently manages exactly one. */
export async function getOrCreateConfig(userId) {
  let config = await ExternalJobAutoFetchConfig.findOne().sort({ createdAt: 1 });
  if (!config) {
    config = await ExternalJobAutoFetchConfig.create({ createdBy: userId, titles: [], locations: [] });
  }
  return config;
}

/** Cartesian product of titles x locations, de-duplicated so the same query never fires twice. */
export function buildQueries(config) {
  const titles = config.titles && config.titles.length ? config.titles : [''];
  const locations = config.locations && config.locations.length ? config.locations : [''];
  const seen = new Set();
  const queries = [];
  for (const title of titles) {
    for (const location of locations) {
      const key = `${String(title).trim().toLowerCase()}|${String(location).trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ title, location });
    }
  }
  return queries;
}

export async function runAutoFetchSync(config, trigger) {
  const run = await ExternalJobSyncRun.create({ configId: config._id, trigger, status: 'running' });
  await ExternalJobAutoFetchConfig.updateOne({ _id: config._id }, { $set: { lastRunStatus: 'running' } });

  const stats = { fetched: 0, created: 0, updated: 0, staleArchived: 0, queriesRun: 0, queriesFailed: 0 };
  const failedQueries = [];
  const seenThisRun = new Set(); // `${source}:${externalId}` -- same job matched by more than one title/location
  const runStartedAt = new Date();
  const queries = buildQueries(config);
  let anyQuerySucceeded = false;

  for (const { title, location } of queries) {
    stats.queriesRun += 1;
    try {
      const rows = await externalJobService.searchFromAPI(
        {
          job_title: title,
          job_location: location,
          date_posted: config.postedRange,
          ...(config.remoteOnly ? { remote: true } : {}),
        },
        config.source,
        SYSTEM_RATE_LIMIT_KEY
      );
      anyQuerySucceeded = true;

      for (const row of rows) {
        stats.fetched += 1;
        if (!row.externalId || !row.source) continue;
        const dedupeKey = `${row.source}:${row.externalId}`;
        if (seenThisRun.has(dedupeKey)) continue;
        seenThisRun.add(dedupeKey);

        try {
          const existing = await Job.exists({
            'externalRef.externalId': row.externalId,
            'externalRef.source': row.source,
          });
          const job = await syncPublishedJobForExternal({
            externalId: row.externalId,
            source: row.source,
            title: row.title,
            company: row.company,
            location: row.location,
            locationMeta: row.locationMeta,
            description: row.description,
            jobType: row.jobType,
            experienceLevel: row.experienceLevel,
            isRemote: row.isRemote,
            salaryMin: row.salaryMin,
            salaryMax: row.salaryMax,
            salaryCurrency: row.salaryCurrency,
            platformUrl: row.platformUrl,
            savedBy: config.createdBy,
          });
          await Job.updateOne(
            { _id: job._id },
            { $set: { autoFetchConfigId: config._id, lastSeenAt: runStartedAt, status: 'Active' } }
          );
          if (existing) stats.updated += 1;
          else stats.created += 1;
        } catch (err) {
          logger.warn(`[auto-fetch] persist failed externalId=${row.externalId}: ${err.message}`);
        }
      }
    } catch (err) {
      stats.queriesFailed += 1;
      failedQueries.push({ title, location, error: err.message || String(err) });
      logger.warn(`[auto-fetch] query failed title="${title}" location="${location}": ${err.message}`);
    }
    if (queries.length > 1) await sleep(RATE_LIMIT_DELAY_MS);
  }

  let status;
  if (queries.length === 0 || !anyQuerySucceeded) status = 'failed';
  else if (stats.queriesFailed > 0) status = 'partial';
  else status = 'completed';

  // Never archive on anything less than a fully successful sync -- a query that
  // failed to reach the provider is not evidence the jobs it would have found
  // are gone.
  if (status === 'completed') {
    const staleResult = await Job.updateMany(
      {
        autoFetchConfigId: config._id,
        status: 'Active',
        $or: [{ lastSeenAt: { $lt: runStartedAt } }, { lastSeenAt: null }],
      },
      { $set: { status: 'Archived' } }
    );
    stats.staleArchived = staleResult.modifiedCount || 0;
  }

  await ExternalJobSyncRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status,
        stats,
        failedQueries,
        completedAt: new Date(),
        errorMessage: status === 'failed' ? failedQueries[0]?.error || 'No queries configured' : null,
      },
    }
  );
  await ExternalJobAutoFetchConfig.updateOne(
    { _id: config._id },
    { $set: { lastRunAt: new Date(), lastRunStatus: status } }
  );

  return { runId: run._id, status, stats, failedQueries };
}
