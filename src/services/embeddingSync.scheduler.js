import User from '../models/user.model.js';
import Role from '../models/role.model.js';
import Employee from '../models/employee.model.js';
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

// ── Upsert helpers ─────────────────────────────────────────────────────────────

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

// ── Backfill ───────────────────────────────────────────────────────────────────

export async function runEmbeddingBackfill() {
  // Hard gate: full re-embedding of every collection is heavy. Default off in production
  // so a Render restart doesn't trigger another full backfill (each restart was re-embedding
  // ~all employees + 180d attendance at the time, spiking RAM and OpenAI cost). Set
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
    // Only the employees namespace is embedded: match_candidates_to_job is the one reader.
    // Jobs, students and attendance are read straight from Mongo by Sage's tools, and a
    // vector top-K can't give exact counts. Their old namespaces are no longer written.

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

  logger.info('[EmbeddingSync] hooks registered');
}
