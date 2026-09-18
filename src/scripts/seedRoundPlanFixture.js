/**
 * Seed the fixture Gate 9 needs, and nothing more.
 *
 * TARGET ENVIRONMENT: whatever MONGODB_URL points at. Staging and local development share
 * ONE database, so a "local" run writes the data staging serves. Production is a separate
 * database — do not point this at it. This creates test records; it never modifies one it
 * did not create.
 *
 *   node src/scripts/seedRoundPlanFixture.js                   # dry run (default)
 *   node src/scripts/seedRoundPlanFixture.js --apply           # create the fixture
 *   node src/scripts/seedRoundPlanFixture.js --undo            # report what undo removes
 *   node src/scripts/seedRoundPlanFixture.js --undo --apply    # remove everything it made
 *
 * WHY THIS EXISTS
 * Staging has 170 jobs and not one has rubricAssignments or interviewRounds, so every
 * by-hand check in Gate 9 had nothing to point at. This builds the smallest set of records
 * that makes all of them runnable.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It creates no Meeting. Scheduling is the code under test — allocateRoundIndex,
 * ensureRoundPlanSnapshot, the planKey pick and the rubricSnapshot copy all run inside
 * createMeeting. Inserting meetings directly would bypass the exact logic Gate 9 exists to
 * prove, and a green check would mean nothing. Schedule through the API or the UI.
 *
 * It also mints no employeeId. The DBS serial hook fires only when a caller sets
 * $locals.assignEmployeeIdNow, and this script never does — a fixture candidate stays a
 * candidate.
 *
 * Everything is written through Mongoose create() so schema validation actually runs, and
 * no save error is swallowed. A past recovery script used raw driver inserts, skipped
 * validation, and quietly produced records the application could not read.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import config from '../config/config.js';
import logger from '../config/logger.js';
import Job from '../models/job.model.js';
import User from '../models/user.model.js';
import Employee from '../models/employee.model.js';
import Meeting from '../models/meeting.model.js';
import JobApplication from '../models/jobApplication.model.js';
import RubricTemplate from '../models/rubricTemplate.model.js';

/**
 * Every record this script creates carries this tag in its name, title or email, and
 * --undo removes by exactly these markers. A fixture that cannot be removed precisely has
 * no business being written to shared data.
 */
const TAG = 'gate9-fixture';
const PREFIX = `[${TAG}]`;
const SEED_EMAIL = `${TAG}-candidate@seed.invalid`;
const TAGGED_NAME = new RegExp(`^\\[${TAG}\\]`);

/* -------------------------------------------------------------------------- *
 * Rubrics. Two templates plus one job-owned criteria list, so the two Technical
 * rounds resolve to visibly DIFFERENT criteria — the case the old
 * one-row-per-round-type model could not express at all.
 * -------------------------------------------------------------------------- */

const SCREENING_CRITERIA = [
  { key: 'communication', label: 'Communication', weight: 50, scaleMin: 1, scaleMax: 5 },
  { key: 'motivation', label: 'Motivation', weight: 50, scaleMin: 1, scaleMax: 5 },
];

const TECHNICAL_CRITERIA = [
  { key: 'coding', label: 'Coding', weight: 60, scaleMin: 1, scaleMax: 5 },
  { key: 'fundamentals', label: 'Fundamentals', weight: 40, scaleMin: 1, scaleMax: 5 },
];

/** Round 3's own criteria. Different keys AND a different scale, so a mix-up is obvious. */
const DEEP_DIVE_CRITERIA = [
  { key: 'system_design', label: 'System design', weight: 70, scaleMin: 1, scaleMax: 10 },
  { key: 'tradeoffs', label: 'Trade-off reasoning', weight: 30, scaleMin: 1, scaleMax: 10 },
];

const jobBase = (title) => ({
  title: `${PREFIX} ${title}`,
  organisation: { name: `${PREFIX} Seed Org` },
  jobDescription: 'Fixture job created for Gate 9 verification. Safe to delete.',
  jobType: 'Full-time',
  location: 'Remote',
});

/* -------------------------------------------------------------------------- *
 * Undo
 * -------------------------------------------------------------------------- */

const runUndo = async (apply) => {
  const jobs = await Job.find({ title: TAGGED_NAME }).select('_id title').lean();
  const jobIds = jobs.map((j) => j._id);

  const applications = jobIds.length
    ? await JobApplication.find({ job: { $in: jobIds } }).select('_id').lean()
    : [];
  const applicationIds = applications.map((a) => a._id);

  /**
   * Meetings scheduled against the fixture while testing. They were created through the
   * API, not by this script, but leaving them behind orphans them against a deleted
   * application — so undo takes them too, and says how many.
   */
  const meetings = applicationIds.length
    ? await Meeting.find({ applicationId: { $in: applicationIds } }).select('_id meetingId').lean()
    : [];

  const employees = await Employee.find({ email: SEED_EMAIL }).select('_id').lean();
  const users = await User.find({ email: SEED_EMAIL }).select('_id').lean();
  const templates = await RubricTemplate.find({ name: TAGGED_NAME }).select('_id name').lean();

  logger.info(
    `[seedRoundPlanFixture] undo ${apply ? 'removing' : 'would remove'}: ` +
      `${meetings.length} meeting(s), ${applicationIds.length} application(s), ` +
      `${employees.length} employee(s), ${users.length} user(s), ${jobs.length} job(s), ` +
      `${templates.length} rubric template(s)`
  );
  for (const j of jobs) logger.info(`[seedRoundPlanFixture]   job: ${j.title}`);
  for (const t of templates) logger.info(`[seedRoundPlanFixture]   rubric: ${t.name}`);

  if (!apply) {
    logger.info('[seedRoundPlanFixture] report only — nothing removed. Add --apply.');
    return;
  }

  // Children before parents, so nothing is left orphaned if this run dies part-way.
  if (meetings.length) await Meeting.deleteMany({ _id: { $in: meetings.map((m) => m._id) } });
  if (applicationIds.length) await JobApplication.deleteMany({ _id: { $in: applicationIds } });
  if (employees.length) await Employee.deleteMany({ _id: { $in: employees.map((e) => e._id) } });
  if (users.length) await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  if (jobIds.length) await Job.deleteMany({ _id: { $in: jobIds } });
  if (templates.length) {
    await RubricTemplate.deleteMany({ _id: { $in: templates.map((t) => t._id) } });
  }
  logger.info('[seedRoundPlanFixture] undo complete.');
};

/* -------------------------------------------------------------------------- *
 * Seed
 * -------------------------------------------------------------------------- */

const runSeed = async (apply) => {
  const existing = await Job.countDocuments({ title: TAGGED_NAME });
  if (existing) {
    logger.warn(
      `[seedRoundPlanFixture] ${existing} fixture job(s) already exist. ` +
        'Run --undo --apply first, then seed again. Refusing to create a second set.'
    );
    return;
  }

  /**
   * Reuse a real staff user as creator and adminId rather than inventing one. Creating a
   * second staff identity on shared data is a bigger footprint than this fixture needs,
   * and every ownership field here only has to be a valid User.
   */
  const staff = await User.findOne({ email: { $not: /@seed\.invalid$/ } })
    .sort({ createdAt: 1 })
    .select('_id name email')
    .lean();
  if (!staff) {
    throw new Error('No existing user found to own the fixture. Aborting rather than guessing.');
  }
  logger.info(`[seedRoundPlanFixture] owner will be ${staff.email} (${String(staff._id)})`);

  if (!apply) {
    logger.info('[seedRoundPlanFixture] DRY RUN — would create:');
    logger.info('  2 rubric templates: Screening rubric, Technical rubric');
    logger.info(`  1 job "${PREFIX} Round plan fixture" with 3 planned rounds:`);
    logger.info('      round_1 Screening    -> Screening rubric (template)');
    logger.info('      round_2 Technical 1  -> Technical rubric (template)');
    logger.info('      round_3 Technical 2  -> its own criteria, scale 1-10');
    logger.info(`  1 job "${PREFIX} Legacy rubric job" with rubricAssignments only (no plan)`);
    logger.info('  1 candidate user + employee, login disabled');
    logger.info('  1 job application per job');
    logger.info('  0 meetings — schedule those through the API, that is the code under test');
    logger.info('[seedRoundPlanFixture] nothing written. Re-run with --apply.');
    return;
  }

  // --- rubric templates -----------------------------------------------------
  const screeningTpl = await RubricTemplate.create({
    name: `${PREFIX} Screening rubric`,
    description: 'Fixture rubric for Gate 9. Safe to delete.',
    criteria: SCREENING_CRITERIA,
    createdBy: staff._id,
  });
  const technicalTpl = await RubricTemplate.create({
    name: `${PREFIX} Technical rubric`,
    description: 'Fixture rubric for Gate 9. Safe to delete.',
    criteria: TECHNICAL_CRITERIA,
    createdBy: staff._id,
  });

  // --- the job under test ---------------------------------------------------
  const planJob = await Job.create({
    ...jobBase('Round plan fixture'),
    createdBy: staff._id,
    interviewRounds: [
      { key: 'round_1', label: 'Screening', roundType: 'screening', templateId: screeningTpl._id },
      { key: 'round_2', label: 'Technical 1', roundType: 'technical', templateId: technicalTpl._id },
      // Same round type as round_2, different rubric. This row is the whole point.
      { key: 'round_3', label: 'Technical 2', roundType: 'technical', criteria: DEEP_DIVE_CRITERIA },
    ],
  });

  /**
   * A job in the pre-plan shape: round-type-keyed assignments, no interviewRounds.
   *
   * Two checks need it. Gate 9 asks that such a job still resolves through rung 2, and the
   * Task 43 migration has never run against a real row — this gives it one.
   */
  const legacyJob = await Job.create({
    ...jobBase('Legacy rubric job'),
    createdBy: staff._id,
    rubricAssignments: [
      { roundType: 'technical', templateId: technicalTpl._id },
      { roundType: null, templateId: screeningTpl._id },
    ],
  });

  // --- candidate ------------------------------------------------------------
  /**
   * A random password and status 'disabled': this identity exists so the Employee has a
   * valid owner, not so anyone can sign in as it.
   */
  const candidateUser = await User.create({
    name: 'Gate9 Fixture Candidate',
    email: SEED_EMAIL,
    // The `A1` prefix is not decoration: User validates that a password contains a capital
    // and a digit, and hex is lower-case with no guaranteed digit. The random tail is what
    // makes it unusable.
    password: `A1${crypto.randomBytes(16).toString('hex')}`,
    status: 'disabled',
  });

  const candidate = await Employee.create({
    owner: candidateUser._id,
    adminId: staff._id,
    fullName: 'Gate9 Fixture Candidate',
    email: SEED_EMAIL,
    phoneNumber: '+10000000000',
  });

  // --- applications ---------------------------------------------------------
  const planApplication = await JobApplication.create({
    job: planJob._id,
    candidate: candidate._id,
    status: 'Applied',
    appliedBy: staff._id,
  });
  const legacyApplication = await JobApplication.create({
    job: legacyJob._id,
    candidate: candidate._id,
    status: 'Applied',
    appliedBy: staff._id,
  });

  // --- what the tester needs ------------------------------------------------
  logger.info(
    [
      '',
      '================ Gate 9 fixture ================',
      `TEMPLATE_SCREENING = ${screeningTpl._id}`,
      `TEMPLATE_TECHNICAL = ${technicalTpl._id}   <- archive this to test the refusal`,
      `JOB_ID             = ${planJob._id}   <- 3 planned rounds`,
      `LEGACY_JOB_ID      = ${legacyJob._id}   <- rubricAssignments only`,
      `CANDIDATE_ID       = ${candidate._id}`,
      `APPLICATION_ID     = ${planApplication._id}`,
      `LEGACY_APP_ID      = ${legacyApplication._id}`,
      'PLAN KEYS          = round_1 (Screening), round_2 (Technical 1), round_3 (Technical 2)',
      '',
      'Rounds 2 and 3 are BOTH roundType=technical with different rubrics:',
      '  round_2 -> Coding 60 / Fundamentals 40, scale 1-5',
      '  round_3 -> System design 70 / Trade-off reasoning 30, scale 1-10',
      'A scheduled round showing the wrong pair means resolution matched on type, not planKey.',
      '',
      'NO MEETINGS WERE CREATED. Schedule them through POST /v1/meetings or the UI —',
      'the round index, the plan snapshot and the rubric copy are the code under test.',
      '',
      'Remove everything again with:',
      '  node src/scripts/seedRoundPlanFixture.js --undo --apply',
      '===============================================',
      '',
    ].join('\n')
  );
};

/* -------------------------------------------------------------------------- *
 * Entry
 * -------------------------------------------------------------------------- */

const main = async () => {
  const apply = process.argv.includes('--apply');
  const undo = process.argv.includes('--undo');

  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  logger.info(
    `[seedRoundPlanFixture] connected to ${mongoose.connection.host}/${mongoose.connection.name} ` +
      `— mode=${undo ? (apply ? 'UNDO' : 'UNDO REPORT') : apply ? 'SEED' : 'DRY RUN'}`
  );

  // Cheap guard, not a real safety net: a production URL can be named anything. The rule
  // is still "do not point this at production" — this only catches the obvious slip.
  if (/prod/i.test(String(mongoose.connection.name))) {
    throw new Error(
      `Database name "${mongoose.connection.name}" looks like production. Refusing to seed test data.`
    );
  }

  if (undo) await runUndo(apply);
  else await runSeed(apply);

  await mongoose.disconnect();
};

main().catch(async (err) => {
  // Never swallow this. A half-written fixture that reports success is worse than a crash.
  logger.error(`[seedRoundPlanFixture] FAILED: ${err?.message || err}`);
  if (err?.errors) {
    for (const [path, detail] of Object.entries(err.errors)) {
      logger.error(`[seedRoundPlanFixture]   ${path}: ${detail?.message || detail}`);
    }
  }
  logger.error('[seedRoundPlanFixture] run --undo --apply to clear anything partly created.');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
