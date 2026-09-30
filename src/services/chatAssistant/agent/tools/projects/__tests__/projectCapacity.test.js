import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';
import {
  ACTIVE_PROJECT_STATUSES,
  MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
  activeProjectsFilter,
  countActiveProjectsByAssignee,
  isAtProjectCapacity,
} from '../../../../../projectCapacity.js';

const oid = () => new mongoose.Types.ObjectId();
const [A, B, C, D, E] = [oid(), oid(), oid(), oid(), oid()];
const TARGET = oid();
const PROJECTS = [
  { _id: TARGET, status: 'Inprogress', assignedTo: [A, B] },
  { _id: oid(), status: 'Inprogress', assignedTo: [A, C, D] },
  { _id: oid(), status: 'On hold', assignedTo: [A, C, D] },
  { _id: oid(), status: 'Inprogress', assignedTo: [D] },
  { _id: oid(), status: 'completed', assignedTo: [B, C, E] },
  { _id: oid(), status: 'completed', assignedTo: [E] },
];
const PEOPLE = [A, B, C, D, E];

/** In-memory Project that evaluates exactly the operators the capacity queries use. */
function fakeProject(projects) {
  const matches = (p, f) => {
    if (f._id?.$ne != null && String(p._id) === String(f._id.$ne)) return false;
    if (f.status?.$in && !f.status.$in.includes(p.status)) return false;
    if (f.assignedTo != null && !p.assignedTo.some((a) => String(a) === String(f.assignedTo))) return false;
    return true;
  };
  return {
    countDocuments: async (f) => projects.filter((p) => matches(p, f)).length,
    aggregate: async (pipeline) => {
      const [first, unwind, second, group, ...rest] = pipeline;
      assert.deepEqual(unwind, { $unwind: '$assignedTo' });
      assert.deepEqual(group, { $group: { _id: '$assignedTo', cnt: { $sum: 1 } } });
      const wanted = new Set(second.$match.assignedTo.$in.map(String));
      const counts = new Map();
      for (const p of projects.filter((x) => matches(x, first.$match))) {
        for (const a of p.assignedTo) if (wanted.has(String(a))) counts.set(String(a), (counts.get(String(a)) || 0) + 1);
      }
      let rows = [...counts].map(([_id, cnt]) => ({ _id, cnt }));
      for (const stage of rest) if (stage.$match?.cnt?.$gte != null) rows = rows.filter((r) => r.cnt >= stage.$match.cnt.$gte);
      return rows;
    },
  };
}
const Project = fakeProject(PROJECTS);

// The rule exactly as pmAssistant.service.js inlined it before the extraction (reference only).
async function legacyGenerateAtCapacity(ownerIds, excludeProjectId) {
  const rows = await Project.aggregate([
    { $match: { _id: { $ne: excludeProjectId }, status: { $in: ['Inprogress', 'On hold'] } } },
    { $unwind: '$assignedTo' },
    { $match: { assignedTo: { $in: ownerIds } } },
    { $group: { _id: '$assignedTo', cnt: { $sum: 1 } } },
    { $match: { cnt: { $gte: 2 } } },
  ]);
  return new Set(rows.map((r) => String(r._id)));
}
async function legacyApplyBlocked(ownerId, projectId, alreadyOnProject) {
  const n = await Project.countDocuments({
    _id: { $ne: projectId }, status: { $in: ['Inprogress', 'On hold'] }, assignedTo: ownerId,
  });
  return n >= 2 && !alreadyOnProject;
}

// The two paths pmAssistant now takes (ownersAtAssigneeCapacityElsewhere / applyAssignmentRun).
async function generateAtCapacity(ownerIds, excludeProjectId) {
  const counts = await countActiveProjectsByAssignee(ownerIds, { excludeProjectId }, { Project });
  return new Set([...counts].filter(([, n]) => isAtProjectCapacity(n)).map(([id]) => id));
}
async function applyBlocked(ownerId, projectId, alreadyOnProject) {
  const n = await Project.countDocuments({ ...activeProjectsFilter(projectId), assignedTo: ownerId });
  return isAtProjectCapacity(n, { alreadyOnProject });
}

describe('projectCapacity', () => {
  it('the rule: 2 other active projects blocks, unless already on the project', () => {
    assert.equal(MAX_ACTIVE_PROJECTS_PER_ASSIGNEE, 2);
    assert.deepEqual([...ACTIVE_PROJECT_STATUSES], ['Inprogress', 'On hold']);
    assert.equal(isAtProjectCapacity(1), false);
    assert.equal(isAtProjectCapacity(2), true);
    assert.equal(isAtProjectCapacity(3, { alreadyOnProject: true }), false);
  });

  it('counts active projects per person, every requested id present (0 when none or invalid)', async () => {
    const counts = await countActiveProjectsByAssignee([...PEOPLE.map(String), 'not-an-id'], {}, { Project });
    assert.deepEqual(Object.fromEntries(counts), {
      [A]: 3, [B]: 1, [C]: 2, [D]: 3, [E]: 0, 'not-an-id': 0,
    });
    const elsewhere = await countActiveProjectsByAssignee(PEOPLE.map(String), { excludeProjectId: TARGET }, { Project });
    assert.equal(elsewhere.get(String(A)), 2);
    assert.equal(elsewhere.get(String(B)), 0);
  });

  it('pmAssistant generate and apply paths agree with each other and with the pre-extraction rule', async () => {
    const generated = await generateAtCapacity(PEOPLE.map(String), TARGET);
    assert.deepEqual(generated, await legacyGenerateAtCapacity(PEOPLE, TARGET));
    for (const person of PEOPLE) {
      for (const alreadyOnProject of [false, true]) {
        const blocked = await applyBlocked(person, TARGET, alreadyOnProject);
        assert.equal(blocked, await legacyApplyBlocked(person, TARGET, alreadyOnProject), `apply ${person} ${alreadyOnProject}`);
        if (!alreadyOnProject) assert.equal(blocked, generated.has(String(person)), `generate vs apply ${person}`);
      }
    }
    assert.deepEqual([...generated].sort(), [String(A), String(C), String(D)].sort());
  });

  it('pmAssistant.service.js takes the rule from projectCapacity instead of inlining it', () => {
    const src = readFileSync(new URL('../../../../../pmAssistant.service.js', import.meta.url), 'utf8');
    assert.match(src, /from '\.\/projectCapacity\.js'/);
    assert.match(src, /countActiveProjectsByAssignee\(ownerUserIds, \{ excludeProjectId \}\)/);
    assert.match(src, /\.\.\.activeProjectsFilter\(project\._id\)/);
    assert.match(src, /isAtProjectCapacity\(activeOnOtherProjects, \{ alreadyOnProject: projectAssignees\.has\(ownerId\) \}\)/);
    assert.doesNotMatch(src, /'Inprogress', 'On hold'/);
    assert.doesNotMatch(src, /\$gte: 2\b|>= 2 &&/);
  });
});
