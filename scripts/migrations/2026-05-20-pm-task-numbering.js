/**
 * Backfill projectKey + nextTaskSeq on projects and taskSeq + taskCode on tasks.
 * Idempotent: projects/tasks already numbered are skipped.
 *
 * Usage:
 *   node scripts/migrations/2026-05-20-pm-task-numbering.js          # dry-run
 *   node scripts/migrations/2026-05-20-pm-task-numbering.js --apply
 */
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { deriveProjectKeyBase, formatTaskCode } from '../../src/services/pmTaskCode.js';

dotenv.config();
const APPLY = process.argv.includes('--apply');

/**
 * Pure: order a project's tasks and assign contiguous seq + code (1-based).
 * @param {string} projectKey
 * @param {Array<{_id:any, order:number, createdAt:Date}>} tasks
 * @returns {Array<{_id:any, taskSeq:number, taskCode:string}>}
 */
export function numberTasksForProject(projectKey, tasks) {
  const sorted = [...tasks].sort((a, b) => {
    const ao = a.order ?? 0;
    const bo = b.order ?? 0;
    if (ao !== bo) return ao - bo;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return sorted.map((t, i) => ({ _id: t._id, taskSeq: i + 1, taskCode: formatTaskCode(projectKey, i + 1) }));
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URL);
  const projects = mongoose.connection.db.collection('projects');
  const tasksCol = mongoose.connection.db.collection('tasks');

  const usedKeys = new Set(
    (await projects.find({ projectKey: { $type: 'string' } }).project({ projectKey: 1 }).toArray())
      .map((p) => p.projectKey)
  );
  const allProjects = await projects.find({}).project({ name: 1, projectKey: 1 }).toArray();

  let projectsUpdated = 0;
  let tasksUpdated = 0;

  for (const proj of allProjects) {
    let key = proj.projectKey;
    if (!key) {
      const base = deriveProjectKeyBase(proj.name);
      key = base;
      for (let n = 2; usedKeys.has(key); n += 1) key = `${base}${n}`;
      usedKeys.add(key);
    }
    const projTasks = await tasksCol
      .find({ projectId: proj._id })
      .project({ order: 1, createdAt: 1, taskSeq: 1 })
      .toArray();
    const unnumbered = projTasks.filter((t) => typeof t.taskSeq !== 'number');
    const maxExistingSeq = projTasks.reduce((m, t) => Math.max(m, t.taskSeq || 0), 0);

    if (APPLY) {
      const numbered = numberTasksForProject(key, unnumbered).map((n) => {
        const seq = n.taskSeq + maxExistingSeq;
        return { _id: n._id, taskSeq: seq, taskCode: formatTaskCode(key, seq) };
      });
      for (const n of numbered) {
        await tasksCol.updateOne({ _id: n._id }, { $set: { taskSeq: n.taskSeq, taskCode: n.taskCode } });
      }
      await projects.updateOne(
        { _id: proj._id },
        { $set: { projectKey: key, nextTaskSeq: maxExistingSeq + unnumbered.length + 1 } }
      );
      tasksUpdated += numbered.length;
    }
    if (!proj.projectKey || unnumbered.length) projectsUpdated += 1;
  }

  console.log(`Projects to update: ${projectsUpdated}. Tasks numbered: ${tasksUpdated}.`);
  if (!APPLY) console.log('Dry-run only. Re-run with --apply to write.');
  await mongoose.disconnect();
}

// Run only when invoked directly as a script, not when imported (e.g. by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
