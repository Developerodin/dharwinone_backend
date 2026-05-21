/**
 * Read-only diagnostic: why aren't all group members assigned to a project?
 *
 * Walks the exact filter chain that pmAssistant.service.js applies and reports,
 * per group member, which stage drops them. Writes NOTHING to the database.
 *
 * Stages (see pmAssistant.service.js / pmGroup.js):
 *   1  loadProjectGroupMembers  — TeamMember.isActive + employeeId != null
 *   2  generateAssignmentRun    — Employee.owner required (excludedMissingOwner)
 *   3  AI distribution          — soft tasksPerEmployee target; member may get 0 rows
 *   4  applyAssignmentRun       — Employee.owner required again
 *   5  capacity                 — owner on >=2 other active projects (hard abort)
 *
 * Usage:
 *   node scripts/diagnose-group-assignment.js
 *   node scripts/diagnose-group-assignment.js --project="AI Native Trainer Phase 1"
 *   node scripts/diagnose-group-assignment.js --project=<projectId> --group="Group A"
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const ACTIVE_PROJECT_STATUSES = ['Inprogress', 'On hold'];

function argValue(flag, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1).replace(/^["']|["']$/g, '') : fallback;
}

const PROJECT_ARG = argValue('--project', 'AI Native Trainer Phase 1');
const GROUP_ARG = argValue('--group', '');

const oid = (v) => {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
};
const idStr = (v) => String(v?._id ?? v ?? '');
const skillCount = (skills) =>
  (Array.isArray(skills) ? skills : []).map((s) => String(s?.name || s || '').trim()).filter(Boolean).length;

async function main() {
  if (!process.env.MONGODB_URL) {
    console.error('MONGODB_URL not set — run from the backend dir so dotenv picks up .env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URL);
  const db = mongoose.connection.db;
  const projects = db.collection('projects');
  const teamgroups = db.collection('teamgroups');
  const teammembers = db.collection('teammembers');
  // The Employee mongoose model is bound to the 'candidates' collection — see
  // employee.model.js:337  mongoose.model('Employee', schema, 'candidates').
  const employees = db.collection('candidates');
  const tasks = db.collection('tasks');
  const assignmentruns = db.collection('assignmentruns');
  const assignmentrows = db.collection('assignmentrows');

  // --- Resolve the project (by id, else case-insensitive name) ---
  let project = null;
  const asId = oid(PROJECT_ARG);
  if (asId) project = await projects.findOne({ _id: asId });
  if (!project) {
    project = await projects.findOne({ name: new RegExp(`^${PROJECT_ARG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  }
  if (!project) {
    console.error(`Project not found: "${PROJECT_ARG}"`);
    const sample = await projects.find({}).project({ name: 1 }).limit(25).toArray();
    console.error('Known projects:', sample.map((p) => p.name).join(' | '));
    await mongoose.disconnect();
    process.exit(1);
  }

  const projId = project._id;
  const taskTotal = await tasks.countDocuments({ projectId: projId });
  const assignedToIds = new Set((project.assignedTo || []).map(idStr).filter(Boolean));

  console.log('=== PROJECT ===');
  console.log(`  name            ${project.name}`);
  console.log(`  _id             ${projId}`);
  console.log(`  status          ${project.status}`);
  console.log(`  tasksPerEmployee ${project.tasksPerEmployee ?? '(unset)'}`);
  console.log(`  tasks in project ${taskTotal}`);
  console.log(`  assignedTo (Users) ${assignedToIds.size}`);
  console.log(`  assignedTeams    ${(project.assignedTeams || []).length}`);

  // --- Resolve assigned teams ---
  const teamIds = (project.assignedTeams || []).map(oid).filter(Boolean);
  let teamDocs = teamIds.length ? await teamgroups.find({ _id: { $in: teamIds } }).toArray() : [];
  if (GROUP_ARG) teamDocs = teamDocs.filter((t) => String(t.name || '').toLowerCase() === GROUP_ARG.toLowerCase());

  console.log('\n=== ASSIGNED TEAMS ===');
  if (teamDocs.length === 0) {
    console.log(GROUP_ARG ? `  no assigned team named "${GROUP_ARG}"` : '  project has no assignedTeams');
  }
  for (const t of teamDocs) console.log(`  ${t.name}  (${t._id})`);

  // --- Latest assignment run + its rows (for stage 3 / status) ---
  const latestRun = await assignmentruns.find({ projectId: projId }).sort({ createdAt: -1 }).limit(1).next();
  const rowsByEmployee = new Map(); // employeeId -> { assigned: n, gap: n }
  if (latestRun) {
    const rows = await assignmentrows.find({ runId: latestRun._id }).toArray();
    for (const r of rows) {
      const cid = idStr(r.recommendedCandidateId);
      if (!cid) continue;
      const e = rowsByEmployee.get(cid) || { assigned: 0, gap: 0 };
      if (r.gap || !r.recommendedCandidateId) e.gap += 1;
      else e.assigned += 1;
      rowsByEmployee.set(cid, e);
    }
  }

  // --- Walk every member of every assigned team through the filter chain ---
  const tally = {
    INACTIVE: 0,
    ORPHAN_ROW: 0,
    EMP_MISSING: 0,
    NO_OWNER: 0,
    OK_ASSIGNED: 0,
    ELIGIBLE_UNASSIGNED: 0,
  };
  let totalMembers = 0;

  for (const team of teamDocs) {
    const members = await teammembers.find({ teamId: team._id }).toArray();
    console.log(`\n=== MEMBERS: ${team.name} (${members.length} TeamMember rows) ===`);

    for (const m of members) {
      totalMembers += 1;
      const label = m.name || m.legacyName || m.legacyEmail || `(row ${m._id})`;

      if (m.isActive === false) {
        tally.INACTIVE += 1;
        console.log(`  [INACTIVE]            ${label}  removedReason=${m.removedReason || '-'}`);
        continue;
      }
      if (!m.employeeId) {
        tally.ORPHAN_ROW += 1;
        console.log(`  [ORPHAN_ROW]          ${label}  orphanReason=${m.orphanReason || '-'}  (stage 1: no Employee link)`);
        continue;
      }

      const emp = await employees.findOne({ _id: m.employeeId });
      if (!emp) {
        tally.EMP_MISSING += 1;
        console.log(`  [EMP_MISSING]         ${label}  employeeId=${m.employeeId} dangling`);
        continue;
      }
      const empLabel = emp.fullName || emp.email || label;

      if (!emp.owner) {
        tally.NO_OWNER += 1;
        console.log(`  [NO_OWNER]            ${empLabel}  (stage 2/4: Employee has no linked User — cannot be a project assignee)`);
        continue;
      }

      const ownerId = idStr(emp.owner);
      const ownerOid = oid(ownerId);
      const otherActive = ownerOid
        ? await projects.countDocuments({
            _id: { $ne: projId },
            status: { $in: ACTIVE_PROJECT_STATUSES },
            assignedTo: ownerOid,
          })
        : 0;
      const runRow = rowsByEmployee.get(idStr(m.employeeId));
      const isAssigned = assignedToIds.has(ownerId);

      if (isAssigned) {
        tally.OK_ASSIGNED += 1;
        console.log(`  [OK_ASSIGNED]         ${empLabel}  owner=${ownerId}  tasksInRun=${runRow?.assigned ?? 0}`);
        continue;
      }

      tally.ELIGIBLE_UNASSIGNED += 1;
      const reasons = [];
      if (!latestRun) reasons.push('no assignment run exists yet');
      else if (latestRun.status !== 'applied') reasons.push(`latest run status="${latestRun.status}" (never applied)`);
      else if (!runRow || runRow.assigned === 0) reasons.push('stage 3: AI gave this member 0 non-gap task rows');
      if (otherActive >= 2) reasons.push(`stage 5: owner on ${otherActive} other active projects (capacity abort)`);
      if (skillCount(emp.skills) === 0) reasons.push('note: Employee has 0 skills (weakens skill-match)');
      console.log(`  [ELIGIBLE_UNASSIGNED] ${empLabel}  owner=${ownerId}  -> ${reasons.join('; ') || 'eligible but not in project.assignedTo'}`);
    }
  }

  // --- Tally ---
  console.log('\n=== TALLY ===');
  console.log(`  total TeamMember rows scanned   ${totalMembers}`);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(22)} ${v}`);
  const dropped = totalMembers - tally.OK_ASSIGNED;
  console.log(`  --> assigned ${tally.OK_ASSIGNED} / ${totalMembers}   (dropped ${dropped})`);

  // --- Latest run ---
  console.log('\n=== LATEST ASSIGNMENT RUN ===');
  if (!latestRun) {
    console.log('  none — no AssignmentRun for this project. The "distribute 5 tasks each" feature was never run.');
  } else {
    console.log(`  _id        ${latestRun._id}`);
    console.log(`  status     ${latestRun.status}  (only "applied" actually writes project.assignedTo)`);
    console.log(`  createdAt  ${latestRun.createdAt}`);
    const gm = latestRun.generationMeta || {};
    console.log('  generationMeta:');
    console.log(`    groupMemberCount            ${gm.groupMemberCount ?? '-'}   (survived stage 1)`);
    console.log(`    eligibleForAi               ${gm.eligibleForAi ?? '-'}   (survived stage 2)`);
    console.log(`    excludedMissingOwner        ${gm.excludedMissingOwner ?? '-'}   (dropped at stage 2)`);
    console.log(`    assignmentTotalTaskCount    ${gm.assignmentTotalTaskCount ?? '-'}`);
    console.log(`    assignmentAiDistinctTaskCount ${gm.assignmentAiDistinctTaskCount ?? '-'}`);
    console.log(`    assignmentBackfilledTaskCount ${gm.assignmentBackfilledTaskCount ?? '-'}   (tasks AI omitted)`);
  }

  // --- Verdict ---
  console.log('\n=== VERDICT ===');
  const ranked = Object.entries(tally)
    .filter(([k]) => k !== 'OK_ASSIGNED')
    .sort((a, b) => b[1] - a[1]);
  const [topStage, topCount] = ranked[0] || ['NONE', 0];
  if (dropped === 0) {
    console.log('  All scanned members are assigned. No drop detected for this team set.');
  } else {
    console.log(`  Biggest drop stage: ${topStage} (${topCount} members).`);
    if (topStage === 'ORPHAN_ROW')
      console.log('  Fix path: re-link Excel-imported members to Employee docs (employeeId), or relax stage-1 filter.');
    if (topStage === 'NO_OWNER')
      console.log('  Fix path: provision User accounts for these Employees — project.assignedTo holds User ids only.');
    if (topStage === 'INACTIVE')
      console.log('  Fix path: these TeamMember rows are deactivated — reactivate or confirm intentional.');
    if (topStage === 'ELIGIBLE_UNASSIGNED')
      console.log('  Fix path: run/apply the AssignmentRun, or AI under-distributed (stage 3) / capacity abort (stage 5).');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('Diagnostic failed:', e?.message || e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
