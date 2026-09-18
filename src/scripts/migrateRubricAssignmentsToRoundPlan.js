/**
 * Migrate Job.rubricAssignments into Job.interviewRounds.
 *
 * TARGET ENVIRONMENT: whatever MONGODB_URL points at. Staging and local development
 * share one database, so a "local" run is a staging run. Production is separate and must
 * be run explicitly, after the backend is deployed there.
 *
 *   node src/scripts/migrateRubricAssignmentsToRoundPlan.js            # dry run (default)
 *   node src/scripts/migrateRubricAssignmentsToRoundPlan.js --apply    # write
 *   node src/scripts/migrateRubricAssignmentsToRoundPlan.js --undo     # clear interviewRounds
 *
 * Idempotent: a job that already has interviewRounds is skipped, so re-running after a
 * partial failure resumes rather than duplicating.
 *
 * The null (job default) assignment row is NOT migrated — it is not a round. It stays in
 * rubricAssignments, which resolveRubricForRound keeps reading as its fallback rung.
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import logger from '../config/logger.js';
import Job from '../models/job.model.js';
import { INTERVIEW_ROUND_TYPES } from '../constants/interviewLinkage.js';
import { roundPlanError, nextPlanKey } from '../constants/interviewRoundPlan.js';

const ROUND_TYPE_LABELS = {
  screening: 'Screening',
  technical: 'Technical',
  panel: 'Panel',
  hr: 'HR',
  behavioral: 'Behavioural',
  hiring_manager: 'Hiring Manager',
  culture: 'Culture Fit',
  final: 'Final',
  other: 'Other',
};

/** Typed assignment rows, in canonical round order, as plan rows. Pure — unit-testable. */
export const planFromAssignments = (assignments) => {
  const typed = (assignments || []).filter((a) => {
    const t = a?.roundType ?? null;
    return t !== null && t !== '' && INTERVIEW_ROUND_TYPES.includes(t);
  });

  typed.sort(
    (a, b) => INTERVIEW_ROUND_TYPES.indexOf(a.roundType) - INTERVIEW_ROUND_TYPES.indexOf(b.roundType)
  );

  const taken = new Set();
  return typed.map((a) => {
    const key = nextPlanKey(taken);
    taken.add(key);
    return {
      key,
      label: ROUND_TYPE_LABELS[a.roundType] || a.roundType,
      roundType: a.roundType,
      templateId: a.templateId || null,
      criteria: Array.isArray(a.criteria) && a.criteria.length ? a.criteria : [],
    };
  });
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const undo = process.argv.includes('--undo');

  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  logger.info(
    `[roundPlanMigration] connected to ${mongoose.connection.host}/${mongoose.connection.name} — ` +
      `mode=${undo ? 'UNDO' : apply ? 'APPLY' : 'DRY RUN'}`
  );

  if (undo) {
    const count = await Job.countDocuments({ 'interviewRounds.0': { $exists: true } });
    if (apply) {
      await Job.updateMany({ 'interviewRounds.0': { $exists: true } }, { $set: { interviewRounds: [] } });
    }
    logger.info(`[roundPlanMigration] undo ${apply ? 'cleared' : 'would clear'} ${count} job(s)`);
    await mongoose.disconnect();
    return;
  }

  const jobs = await Job.find({
    'rubricAssignments.0': { $exists: true },
    $or: [{ interviewRounds: { $exists: false } }, { interviewRounds: { $size: 0 } }],
  })
    .select('title rubricAssignments')
    .lean();

  let migrated = 0;
  let skippedNoTyped = 0;
  const refused = [];

  for (const job of jobs) {
    const plan = planFromAssignments(job.rubricAssignments);

    if (!plan.length) {
      skippedNoTyped += 1;
      continue;
    }

    const reason = roundPlanError(plan);
    if (reason) {
      refused.push({ id: String(job._id), title: job.title, reason });
      continue;
    }

    logger.info(
      `[roundPlanMigration] ${apply ? 'migrating' : 'would migrate'} "${job.title}" ` +
        `(${String(job._id)}) -> ${plan.map((r) => r.label).join(' -> ')}`
    );

    if (apply) {
      await Job.updateOne({ _id: job._id }, { $set: { interviewRounds: plan } });
    }
    migrated += 1;
  }

  logger.info(
    `[roundPlanMigration] ${apply ? 'migrated' : 'would migrate'} ${migrated} job(s); ` +
      `${skippedNoTyped} had only a job-default row (left as-is); ${refused.length} refused`
  );
  for (const r of refused) {
    logger.warn(`[roundPlanMigration] REFUSED ${r.title} (${r.id}): ${r.reason}`);
  }
  if (!apply) logger.info('[roundPlanMigration] dry run — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
};

main().catch((err) => {
  logger.error(`[roundPlanMigration] failed: ${err?.message || err}`);
  process.exit(1);
});
