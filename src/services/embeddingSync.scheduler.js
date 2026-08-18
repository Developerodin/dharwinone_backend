import Student from '../models/student.model.js';
import Job from '../models/job.model.js';
import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import Employee from '../models/employee.model.js';
import Attendance from '../models/attendance.model.js';
import { embedTexts } from '../utils/embedding.util.js';
import { pineconeUpsert, ensureIndex } from '../utils/pinecone.util.js';
import logger from '../config/logger.js';

const BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 50);
const BACKFILL_INTER_BATCH_DELAY_MS = Number(process.env.EMBEDDING_BACKFILL_DELAY_MS || 200);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Streams a Mongoose query in fixed-size chunks via cursor (constant memory)
 * and hands each chunk to `handler`. Replaces the prior skip()/limit() pattern,
 * which is O(n²) on the DB side and grows offsets in RAM as collections grow.
 */
async function processCursor(query, handler, batchSize, label) {
  const cursor = query.lean().cursor({ batchSize });
  let buf = [];
  let processed = 0;
  try {
    // eslint-disable-next-line no-restricted-syntax -- cursor must be drained sequentially
    for await (const doc of cursor) {
      buf.push(doc);
      if (buf.length >= batchSize) {
        // eslint-disable-next-line no-await-in-loop -- back-pressure to keep RAM bounded
        await handler(buf);
        processed += buf.length;
        logger.info(`[EmbeddingSync] ${label} ${processed}`);
        buf = []; // release ref so the previous batch's docs/embeddings/vectors can be GCed
        if (BACKFILL_INTER_BATCH_DELAY_MS > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(BACKFILL_INTER_BATCH_DELAY_MS);
        }
      }
    }
    if (buf.length) {
      await handler(buf);
      processed += buf.length;
      logger.info(`[EmbeddingSync] ${label} ${processed}`);
      buf = [];
    }
  } finally {
    if (typeof cursor.close === 'function') await cursor.close().catch(() => {});
  }
  return processed;
}

// ── Text builders ──────────────────────────────────────────────────────────────

function studentText(student, userName) {
  const skills = (student.skills ?? []).join(' ');
  const titles = (student.experience ?? []).map((e) => e.title).join(' ');
  return `${userName} ${skills} ${titles}`.trim();
}

function jobText(job) {
  const tags = (job.skillTags ?? []).join(' ');
  const skillReqs = (job.skillRequirements ?? [])
    .map((s) => `${s.name ?? ''}${s.level ? ` ${s.level}` : ''}${s.required ? ' required' : ''}`)
    .join(' ');
  const org = job.organisation || {};
  const salary = job.salaryRange
    ? `${job.salaryRange.min ?? ''} ${job.salaryRange.max ?? ''} ${job.salaryRange.currency ?? ''}`.trim()
    : '';
  const origin = job.jobOrigin === 'external' ? 'external listing' : 'internal opening';
  const extSource = job.externalRef?.source ?? '';
  return [
    job.title,
    job.jobDescription ?? '',
    tags,
    skillReqs,
    job.jobType ?? '',
    job.location ?? '',
    job.experienceLevel ?? '',
    job.status ?? '',
    org.name ?? '',
    org.description ?? '',
    org.address ?? '',
    salary,
    origin,
    extSource,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function employeeUserText(u, profile) {
  const domains = (u.domain ?? []).join(' ');
  const skills = ((profile?.skills) ?? [])
    .map((s) => `${s.name ?? ''}${s.level ? ` ${s.level}` : ''}${s.category ? ` ${s.category}` : ''}`)
    .join(' ');
  const exps = ((profile?.experiences) ?? [])
    .map((e) => `${e.role ?? ''} at ${e.company ?? ''} ${e.description ?? ''}`)
    .join(' ');
  const quals = ((profile?.qualifications) ?? [])
    .map((q) => `${q.degree ?? ''} ${q.institute ?? ''} ${q.description ?? ''}`)
    .join(' ');
  const addr = profile?.address
    ? `${profile.address.city ?? ''} ${profile.address.state ?? ''} ${profile.address.country ?? ''}`.trim()
    : '';
  return [
    u.name,
    profile?.fullName ?? '',
    profile?.employeeId ?? '',
    profile?.designation ?? '',
    profile?.department ?? '',
    profile?.shortBio ?? '',
    domains,
    u.location ?? '',
    addr,
    u.profileSummary ?? '',
    skills,
    exps,
    quals,
    profile?.degree ?? '',
    profile?.visaType ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function attendanceText(rec, ownerName) {
  const date = rec.date ? new Date(rec.date).toISOString().slice(0, 10) : '';
  return [
    ownerName ?? '',
    'attendance',
    rec.day ?? '',
    date,
    rec.status ?? '',
    rec.leaveType ?? '',
    rec.notes ?? '',
    rec.timezone ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

// ── Upsert helpers ─────────────────────────────────────────────────────────────

async function upsertStudents(students) {
  if (!students.length) return;

  const userIds = [...new Set(students.map((s) => String(s.user)))];
  const users = await User.find({ _id: { $in: userIds } }, { _id: 1, adminId: 1, name: 1 }).lean();
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

  // Pre-filter to rows whose user still exists — keeps text/embedding arrays aligned.
  // This used to require adminId, which dropped 4 of the 6 Student-role users for a
  // field nothing queries here.
  const eligible = students.filter((s) => userMap[String(s.user)]);
  const skipped = students.length - eligible.length;
  if (skipped) logger.info(`[EmbeddingSync] students: ${eligible.length} eligible, ${skipped} skipped (no user)`);
  if (!eligible.length) return;

  const texts = eligible.map((s) => studentText(s, userMap[String(s.user)]?.name ?? '') || 'candidate');
  const embeddings = await embedTexts(texts);

  const vectors = eligible.map((s, i) => {
    const u = userMap[String(s.user)];
    return {
      id: `student_${s._id}`,
      values: embeddings[i],
      metadata: {
        ...(u?.adminId ? { adminId: String(u.adminId) } : {}),
        mongoId: String(s._id),
        isActive: true,
      },
    };
  });

  await pineconeUpsert('students', vectors);
}

async function upsertJobs(jobs) {
  if (!jobs.length) return;
  // Resolve each creator's top-level adminId so Pinecone filter works company-wide
  const creatorIds = [...new Set(jobs.map((j) => String(j.createdBy)))];
  const creators = await User.find({ _id: { $in: creatorIds } }, { _id: 1, adminId: 1 }).lean();
  const creatorMap = Object.fromEntries(creators.map((u) => [String(u._id), u]));

  const texts = jobs.map((j) => jobText(j) || 'job posting');
  const embeddings = await embedTexts(texts);
  const vectors = jobs.map((j, i) => {
    const creator = creatorMap[String(j.createdBy)];
    const adminId = creator?.adminId ? String(creator.adminId) : String(j.createdBy);
    return {
      id: `job_${j._id}`,
      values: embeddings[i],
      metadata: {
        adminId,
        mongoId: String(j._id),
        // The chatbot filters on `status` (chatAssistant.service.js:2666) with the
        // full Job enum — Draft|Active|Closed|Archived. This used to write a boolean
        // `isActive` instead, which nothing read and which collapsed the three
        // non-active states together, so every status-filtered query matched zero
        // points and silently fell through to the unranked path.
        status: String(j.status ?? ''),
        jobOrigin: String(j.jobOrigin ?? 'internal'),
        jobType: String(j.jobType ?? ''),
        location: String(j.location ?? ''),
        experienceLevel: String(j.experienceLevel ?? ''),
        company: String(j.organisation?.name ?? ''),
        externalSource: String(j.externalRef?.source ?? ''),
      },
    };
  });
  await pineconeUpsert('jobs', vectors);
}

async function upsertEmployeeUsers(users) {
  if (!users.length) return;

  const ownerIds = users.map((u) => u._id);
  const profiles = await Employee.find(
    { owner: { $in: ownerIds } },
    {
      owner: 1, employeeId: 1, fullName: 1, designation: 1, department: 1, shortBio: 1,
      skills: 1, experiences: 1, qualifications: 1, address: 1, isActive: 1,
      degree: 1, visaType: 1, joiningDate: 1,
    }
  ).lean();
  const profMap = Object.fromEntries(profiles.map((p) => [String(p.owner), p]));

  const texts = users.map((u) => employeeUserText(u, profMap[String(u._id)]) || 'employee');
  const embeddings = await embedTexts(texts);
  const vectors = users.map((u, i) => {
    const p = profMap[String(u._id)];
    const skillNames = (p?.skills ?? []).map((s) => s.name).filter(Boolean).join(',').slice(0, 1000);
    return {
      id: `employee_${u._id}`,
      values: embeddings[i],
      metadata: {
        // Omitted rather than String(undefined) — most employees carry adminId on the
        // Employee row only, and a literal "undefined" would be a matchable value.
        ...(u.adminId ? { adminId: String(u.adminId) } : {}),
        mongoId: String(u._id),
        isActive: u.status === 'active',
        employeeId: String(p?.employeeId ?? ''),
        designation: String(p?.designation ?? ''),
        department: String(p?.department ?? ''),
        skillsList: skillNames,
        hasProfile: !!p,
        isActiveEmployee: !!p?.isActive,
      },
    };
  });
  await pineconeUpsert('employees', vectors);
}

async function upsertAttendance(records) {
  if (!records.length) return;

  const userIds = [...new Set(records.map((r) => String(r.user ?? '')).filter(Boolean))];
  const users = await User.find({ _id: { $in: userIds } }, { _id: 1, name: 1, adminId: 1 }).lean();
  const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));

  // Requires only that the user still exists. Requiring adminId here dropped
  // attendance for everyone whose User row never received one — the same 65 people
  // the employees step used to lose — for a field nothing queries in this namespace.
  const eligible = records.filter((r) => r.user && userMap[String(r.user)]);
  const skipped = records.length - eligible.length;
  if (skipped) logger.info(`[EmbeddingSync] attendance: ${eligible.length} eligible, ${skipped} skipped (no user)`);
  if (!eligible.length) return;

  const texts = eligible.map((r) => attendanceText(r, userMap[String(r.user)]?.name) || 'attendance');
  const embeddings = await embedTexts(texts);
  const vectors = eligible.map((r, i) => {
    const u = userMap[String(r.user)];
    const dateStr = r.date ? new Date(r.date).toISOString().slice(0, 10) : '';
    return {
      id: `attendance_${r._id}`,
      values: embeddings[i],
      metadata: {
        ...(u.adminId ? { adminId: String(u.adminId) } : {}),
        mongoId: String(r._id),
        userId: String(r.user),
        userName: String(u.name ?? ''),
        date: dateStr,
        dateMs: r.date ? new Date(r.date).getTime() : 0,
        day: String(r.day ?? ''),
        status: String(r.status ?? ''),
        leaveType: String(r.leaveType ?? ''),
        isActive: !!r.isActive,
        durationMs: Number(r.duration ?? 0),
      },
    };
  });
  await pineconeUpsert('attendance', vectors);
}

// ── Backfill ───────────────────────────────────────────────────────────────────

export async function runEmbeddingBackfill() {
  // Hard gate: full re-embedding of every collection is heavy. Default off in production
  // so a Render restart doesn't trigger another full backfill (each restart was re-embedding
  // ~all employees + 180d attendance, spiking RAM and OpenAI cost). Set
  // EMBEDDING_BACKFILL_ON_BOOT=1 for a one-time intentional backfill, then unset it.
  const enabled = ['1', 'true', 'yes'].includes(
    String(process.env.EMBEDDING_BACKFILL_ON_BOOT ?? '').trim().toLowerCase()
  );
  if (!enabled) {
    logger.info('[EmbeddingSync] backfill skipped (EMBEDDING_BACKFILL_ON_BOOT not set)');
    return;
  }

  logger.info('[EmbeddingSync] backfill started');
  await ensureIndex();

  let step = 'init';
  try {
    step = 'students';
    // Student is a user role held by 6 users and has nothing to do with jobs. The
    // students COLLECTION is a different thing: a per-person attendance/HR profile
    // created for everyone (205 rows, ~15k attendance records keyed to it), so
    // embedding all of it put 188 employees into a namespace called `students`.
    // Scope to the actual role; the collection itself stays untouched.
    const studentRole = await Role.findOne({ name: 'Student' }, { _id: 1 }).lean();
    const studentUserIds = studentRole ? await User.distinct('_id', { roleIds: studentRole._id }) : [];
    await processCursor(
      Student.find({ user: { $in: studentUserIds } }, { user: 1, skills: 1, experience: 1 }),
      upsertStudents,
      BATCH_SIZE,
      'students'
    );

    step = 'jobs';
    await processCursor(
      Job.find({}, {
        title: 1, jobDescription: 1, skillTags: 1, skillRequirements: 1,
        createdBy: 1, status: 1, jobType: 1, location: 1, experienceLevel: 1,
        organisation: 1, salaryRange: 1, jobOrigin: 1, externalRef: 1, externalPlatformUrl: 1,
      }),
      upsertJobs,
      BATCH_SIZE,
      'jobs'
    );

    // No external_jobs step: every ExternalJob is mirrored into a Job row
    // (jobOrigin: 'external'), and the `jobs` cursor above is unfiltered, so those
    // listings are already embedded. Embedding them a second time into a namespace
    // no query reads only doubled the API spend. The chatbot reaches external jobs
    // through the mirrored rows — chatAssistant.service.js#fetch_external_jobs.

    step = 'employees';
    // Was gated on `adminId: { $exists: true, $ne: null }`, which silently skipped 65
    // real employees: adminId is written to the Employee (candidates) row, not always
    // back onto the User. It was never an "is an employee" test.
    //
    // Nor is "owns a profile row": Administrators, Agents and Testers all carry
    // Employee records with DBS ids, so keying off the profile alone embedded 213
    // people where Settings → Roles shows 192 employees. Role is the definition the
    // product uses, so use it. Candidate is included because both employees and
    // candidates can apply for a job — match_candidates_to_job reads this namespace.
    const [employeeRole, candidateRole] = await Promise.all([
      Role.findOne({ name: 'Employee' }, { _id: 1 }).lean(),
      Role.findOne({ name: 'Candidate' }, { _id: 1 }).lean(),
    ]);
    const workforceRoleIds = [employeeRole?._id, candidateRole?._id].filter(Boolean);
    const employeeOwnerIds = await Employee.distinct('owner', { owner: { $ne: null } });
    const empFilter = {
      _id: { $in: employeeOwnerIds },
      roleIds: { $in: workforceRoleIds },
      status: { $ne: 'deleted' },
    };
    await processCursor(
      User.find(empFilter, { name: 1, domain: 1, location: 1, profileSummary: 1, adminId: 1, status: 1 }),
      upsertEmployeeUsers,
      BATCH_SIZE,
      'employees'
    );

    step = 'attendance';
    // Cap to last 180 days to avoid embedding decade-old records.
    const attendanceCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const attFilter = { user: { $exists: true, $ne: null }, date: { $gte: attendanceCutoff } };
    await processCursor(
      Attendance.find(attFilter, {
        user: 1, date: 1, day: 1, status: 1, leaveType: 1, notes: 1,
        duration: 1, timezone: 1, isActive: 1,
      }).sort({ date: -1 }),
      upsertAttendance,
      BATCH_SIZE,
      'attendance'
    );

    logger.info('[EmbeddingSync] backfill complete');
  } catch (err) {
    logger.error(`[EmbeddingSync] backfill failed at step=${step}: ${err?.stack || err?.message || String(err)}`);
    throw err;
  }
}

/**
 * Employee ∪ Candidate — the definition of the `employees` namespace, matching what
 * Settings → Roles calls employees. Keeps the post-save hooks in step with the
 * backfill filter; without it a single Agent/Administrator save would put someone
 * back into the namespace the backfill deliberately leaves out.
 * @param {{ roleIds?: any[] }|null} user
 */
async function hasWorkforceRole(user) {
  if (!user?.roleIds?.length) return false;
  const roles = await Role.find({ name: { $in: ['Employee', 'Candidate'] } }, { _id: 1 }).lean();
  const ids = new Set(roles.map((r) => String(r._id)));
  return user.roleIds.some((r) => ids.has(String(r)));
}

// ── Post-save hooks ────────────────────────────────────────────────────────────

export function registerEmbeddingHooks() {
  Student.schema.post(['save', 'findOneAndUpdate'], async function (doc) {
    try {
      if (!doc) return;
      const u = await User.findById(doc.user, { adminId: 1, name: 1, roleIds: 1 }).lean();
      if (!u) return;
      // Only actual Student-role users belong in this namespace — the students
      // collection itself holds an attendance profile for everyone.
      const studentRole = await Role.findOne({ name: 'Student' }, { _id: 1 }).lean();
      if (!studentRole || !(u.roleIds || []).some((r) => String(r) === String(studentRole._id))) return;
      const text = studentText(doc, u.name ?? '');
      const [emb] = await embedTexts([text]);
      await pineconeUpsert('students', [
        {
          id: `student_${doc._id}`,
          values: emb,
          metadata: {
            ...(u.adminId ? { adminId: String(u.adminId) } : {}),
            mongoId: String(doc._id),
            isActive: true,
          },
        },
      ]);
    } catch (err) {
      logger.error(`[EmbeddingSync] student hook error: ${err?.stack || err?.message || String(err)}`);
    }
  });

  Job.schema.post(['save', 'findOneAndUpdate'], async function (doc) {
    try {
      if (!doc) return;
      const text = jobText(doc);
      const [emb] = await embedTexts([text]);
      const creator = doc.createdBy ? await User.findById(doc.createdBy, { adminId: 1 }).lean() : null;
      const adminId = creator?.adminId ? String(creator.adminId) : String(doc.createdBy);
      await pineconeUpsert('jobs', [
        {
          id: `job_${doc._id}`,
          values: emb,
          metadata: {
            adminId,
            mongoId: String(doc._id),
            // Must match upsertJobs' payload exactly — this hook overwrites the
            // backfill's point on every save, so a divergence here silently
            // reverts the field the chatbot filters on.
            status: String(doc.status ?? ''),
            jobOrigin: String(doc.jobOrigin ?? 'internal'),
            jobType: String(doc.jobType ?? ''),
            location: String(doc.location ?? ''),
            experienceLevel: String(doc.experienceLevel ?? ''),
            company: String(doc.organisation?.name ?? ''),
            externalSource: String(doc.externalRef?.source ?? ''),
          },
        },
      ]);
    } catch (err) {
      logger.error(`[EmbeddingSync] job hook error: ${err?.stack || err?.message || String(err)}`);
    }
  });

  // No ExternalJob hook: saving an ExternalJob does not need its own embedding.
  // Publishing one creates/updates the mirrored Job row, and the Job hook above
  // embeds that. See the backfill for why the second namespace was dropped.

  User.schema.post(['save', 'findOneAndUpdate'], async function (doc) {
    try {
      if (!doc?._id) return;
      const profile = await Employee.findOne(
        { owner: doc._id },
        {
          owner: 1, employeeId: 1, fullName: 1, designation: 1, department: 1, shortBio: 1,
          skills: 1, experiences: 1, qualifications: 1, address: 1, isActive: 1,
          degree: 1, visaType: 1,
        }
      ).lean();
      // Same rule as the backfill: an HR profile AND an Employee/Candidate role.
      if (!profile) return;
      if (!(await hasWorkforceRole(doc))) return;
      const text = employeeUserText(doc, profile);
      const [emb] = await embedTexts([text || 'employee']);
      const skillsList = (profile?.skills ?? []).map((s) => s.name).filter(Boolean).join(',').slice(0, 1000);
      await pineconeUpsert('employees', [
        {
          id: `employee_${doc._id}`,
          values: emb,
          metadata: {
            ...(doc.adminId ? { adminId: String(doc.adminId) } : {}),
            mongoId: String(doc._id),
            isActive: doc.status === 'active',
            employeeId: String(profile?.employeeId ?? ''),
            designation: String(profile?.designation ?? ''),
            department: String(profile?.department ?? ''),
            skillsList,
            hasProfile: !!profile,
            isActiveEmployee: !!profile?.isActive,
          },
        },
      ]);
    } catch (err) {
      logger.error(`[EmbeddingSync] user/employee hook error: ${err?.stack || err?.message || String(err)}`);
    }
  });

  Employee.schema.post(['save', 'findOneAndUpdate'], async function (doc) {
    try {
      if (!doc?.owner) return;
      const owner = await User.findById(doc.owner, { _id: 1, name: 1, adminId: 1, domain: 1, location: 1, profileSummary: 1, status: 1, roleIds: 1 }).lean();
      // Requiring owner.adminId here dropped the same 65 people the backfill dropped.
      // Role still gates it, so Admin/Agent profile edits stay out of the namespace.
      if (!owner) return;
      if (!(await hasWorkforceRole(owner))) return;
      const text = employeeUserText(owner, doc);
      const [emb] = await embedTexts([text || 'employee']);
      const skillsList = (doc.skills ?? []).map((s) => s.name).filter(Boolean).join(',').slice(0, 1000);
      await pineconeUpsert('employees', [
        {
          id: `employee_${owner._id}`,
          values: emb,
          metadata: {
            ...(owner.adminId ? { adminId: String(owner.adminId) } : {}),
            mongoId: String(owner._id),
            isActive: owner.status === 'active',
            employeeId: String(doc.employeeId ?? ''),
            designation: String(doc.designation ?? ''),
            department: String(doc.department ?? ''),
            skillsList,
            hasProfile: true,
            isActiveEmployee: !!doc.isActive,
          },
        },
      ]);
    } catch (err) {
      logger.error(`[EmbeddingSync] employee profile hook error: ${err?.stack || err?.message || String(err)}`);
    }
  });

  Attendance.schema.post(['save', 'findOneAndUpdate'], async function (doc) {
    try {
      if (!doc?.user) return;
      const owner = await User.findById(doc.user, { _id: 1, name: 1, adminId: 1 }).lean();
      if (!owner) return;
      const text = attendanceText(doc, owner.name);
      const [emb] = await embedTexts([text || 'attendance']);
      const dateStr = doc.date ? new Date(doc.date).toISOString().slice(0, 10) : '';
      await pineconeUpsert('attendance', [
        {
          id: `attendance_${doc._id}`,
          values: emb,
          metadata: {
            ...(owner.adminId ? { adminId: String(owner.adminId) } : {}),
            mongoId: String(doc._id),
            userId: String(doc.user),
            userName: String(owner.name ?? ''),
            date: dateStr,
            dateMs: doc.date ? new Date(doc.date).getTime() : 0,
            day: String(doc.day ?? ''),
            status: String(doc.status ?? ''),
            leaveType: String(doc.leaveType ?? ''),
            isActive: !!doc.isActive,
            durationMs: Number(doc.duration ?? 0),
          },
        },
      ]);
    } catch (err) {
      logger.error(`[EmbeddingSync] attendance hook error: ${err?.stack || err?.message || String(err)}`);
    }
  });

  logger.info('[EmbeddingSync] hooks registered');
}
