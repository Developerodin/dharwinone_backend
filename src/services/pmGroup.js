import Employee from '../models/employee.model.js';
import TeamMember from '../models/team.model.js';

const GROUP_ROSTER_MAX = 40;
const SKILLS_PER_MEMBER_MAX = 8;

/** Normalise an Employee skills array (objects with .name, or plain strings) to string[]. */
export function skillNames(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map((s) => String(s?.name || s || '').trim())
    .filter(Boolean);
}

/**
 * Project Employee docs to the compact roster sent to the breakdown model.
 * @param {object[]} employees
 * @returns {Array<{name:string,designation:string,department:string,skills:string[]}>}
 */
export function buildGroupMembersForPrompt(employees) {
  return (Array.isArray(employees) ? employees : []).slice(0, GROUP_ROSTER_MAX).map((e) => ({
    name: String(e.fullName || e.email || 'Member').trim(),
    designation: String(e.designation || '').trim(),
    department: String(e.department || '').trim(),
    skills: skillNames(e.skills).slice(0, SKILLS_PER_MEMBER_MAX),
  }));
}

/**
 * Designation -> member count map, for groups large enough that the model
 * benefits from a shape summary before the per-member rows.
 * @param {Array<{designation?:string}>} groupMembers
 * @returns {Record<string, number>}
 */
export function buildGroupCapabilitySummary(groupMembers) {
  const counts = {};
  for (const m of Array.isArray(groupMembers) ? groupMembers : []) {
    const key = String(m.designation || '').trim() || 'Unspecified';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** Strict boolean coercion — only literal `true` counts. */
export function coerceMoreTasksLikely(value) {
  return value === true;
}

/**
 * Distinct tags + requiredSkills already present in a task list, capped at 40.
 * @param {Array<{tags?:string[],requiredSkills?:string[]}>} tasks
 * @returns {string[]}
 */
export function extractCoveredThemes(tasks) {
  const out = new Set();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    for (const tag of Array.isArray(t.tags) ? t.tags : []) {
      const v = String(tag || '').trim();
      if (v) out.add(v);
    }
    for (const sk of Array.isArray(t.requiredSkills) ? t.requiredSkills : []) {
      const v = String(sk || '').trim();
      if (v) out.add(v);
    }
  }
  return [...out].slice(0, 40);
}

/**
 * Load the active, linked Employee docs for a project's assigned groups.
 * @param {object} project - project doc with assignedTeams
 * @returns {Promise<object[]>} Employee docs
 */
export async function loadProjectGroupMembers(project) {
  const teamIds = (project?.assignedTeams || []).map((t) => t?._id || t).filter(Boolean);
  if (!teamIds.length) return [];
  const rows = await TeamMember.find({
    teamId: { $in: teamIds },
    isActive: true,
    employeeId: { $ne: null },
  })
    .select('employeeId')
    .lean();
  const employeeIds = [...new Set(rows.map((r) => String(r.employeeId)).filter(Boolean))];
  if (!employeeIds.length) return [];
  return Employee.find({ _id: { $in: employeeIds } })
    .select('fullName email skills designation department experiences experience owner')
    .lean();
}

/**
 * Explain why a task could not be staffed from the group.
 * @param {{requiredSkills?:string[]}} task
 * @param {object[]} groupMembers - Employee docs
 */
export function buildGapReason(task, groupMembers) {
  const needs = (Array.isArray(task?.requiredSkills) ? task.requiredSkills : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const needLower = needs.map((s) => s.toLowerCase());
  const scored = [];
  const skillsCoveredLower = new Set();
  for (const m of Array.isArray(groupMembers) ? groupMembers : []) {
    const memberLower = new Set(skillNames(m.skills).map((s) => s.toLowerCase()));
    const matched = needs.filter((_, i) => memberLower.has(needLower[i]));
    for (const ml of memberLower) skillsCoveredLower.add(ml);
    if (matched.length > 0) {
      scored.push({
        employeeId: String(m._id),
        name: String(m.fullName || m.email || 'Member'),
        matchedSkills: matched,
      });
    }
  }
  scored.sort((a, b) => b.matchedSkills.length - a.matchedSkills.length);
  const missingSkills = needs.filter((_, i) => !skillsCoveredLower.has(needLower[i]));
  return {
    missingSkills,
    noQualifiedMember: scored.length === 0,
    closestCandidates: scored.slice(0, 3),
  };
}
