// Resume fields the Candidates page returns on GET /employees/:candidateId
// (employee.route.js + employee.controller.js `get`): the full profile, including
// skills, qualifications and experiences, for anyone who can open that candidate.
// That is wider than the employee provider, which gates qualifications and
// experiences on employees.read. Salary, documents and recruiter notes stay on
// the candidate provider's own gates — this module does not add them.
//
// Same Employee document and the same summary text the employee provider shows
// (skillsSummary / qualificationsSummary / experiencesSummary). Empty → null,
// never a guessed résumé.

import { hasApiPermissionFromContext } from '../../../../../utils/permissionCheck.js';
import { userCanViewPreBoardingDocs } from '../../../../../controllers/employee.controller.js';
import {
  experiencesSummary,
  qualificationsSummary,
  skillsSummary,
} from '../../../personProfile/providers/employee.js';

const RESUME_KEYS = ['skills', 'qualifications', 'experiences', 'yearsOfExperience', 'resumeSummary'];

// GET /employees/:candidateId (employee.route.js + employee.controller.js `get`).
// The route accepts candidates.read / employees.read / pre-boarding.read / onboarding.read.
// The controller then refuses unless the viewer can see all employees, can see pre-boarding
// docs, or is the owner. getMyCandidate (auth only) returns the same fields to the owner.
const CANDIDATE_PAGE_READ = ['candidates.read', 'employees.read', 'pre-boarding.read', 'onboarding.read'];

/** True when this viewer would receive skills / qualifications / experiences from the Candidates page. */
export function canSeeCandidateResume(user, targetUserId) {
  if (user?.platformSuperUser) return true;
  const selfId = user?.id ?? user?._id;
  if (!user?.__impersonating && selfId != null && String(selfId) === String(targetUserId)) return true;
  const perms = user?.authContext?.permissions;
  const can = (p) => hasApiPermissionFromContext(perms, false, p);
  if (!CANDIDATE_PAGE_READ.some(can)) return false;
  if (can('employees.read') || can('candidates.read') || can('candidates.manage') || can('employees.manage')) {
    return true;
  }
  return userCanViewPreBoardingDocs(perms);
}

/** Page would hide these fields: list them as redacted and do not read the document. */
export function redactCandidateResume(candidateProfile) {
  return {
    ...candidateProfile,
    redacted: [...new Set([...(candidateProfile.redacted || []), ...RESUME_KEYS])],
  };
}

/**
 * Years covered by experiences that have a start and an end (or currentlyWorking).
 * No experiences, or none with both ends, → null. Not the unused calculator in
 * employee.service.js (it returns 0 for an empty list, which would read as "zero years").
 */
export function yearsOfExperience(experiences, now = new Date()) {
  if (!Array.isArray(experiences) || experiences.length === 0) return null;
  let totalMonths = 0;
  let dated = 0;
  for (const exp of experiences) {
    const start = exp?.startDate ? new Date(exp.startDate) : null;
    if (!start || !Number.isFinite(start.getTime())) continue;
    const end = exp?.currentlyWorking ? now : (exp?.endDate ? new Date(exp.endDate) : null);
    if (!end || !Number.isFinite(end.getTime())) continue;
    dated += 1;
    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    totalMonths += Math.max(0, months);
  }
  if (!dated) return null;
  return Math.round((totalMonths / 12) * 10) / 10;
}

/** @returns {Record<string, string|number|null>} every key present; missing data is null. */
export function candidateResumeFromDoc(doc, now = new Date()) {
  const skills = doc ? skillsSummary(doc) : null;
  const qualifications = doc ? qualificationsSummary(doc) : null;
  const experiences = doc ? experiencesSummary(doc) : null;
  const years = doc ? yearsOfExperience(doc.experiences, now) : null;
  const lines = [];
  if (skills) lines.push(`Skills: ${skills}`);
  if (qualifications) lines.push(`Qualifications: ${qualifications}`);
  if (experiences) lines.push(`Experience: ${experiences}`);
  if (years != null) lines.push(`Years of experience: ${years}`);
  return {
    skills,
    qualifications,
    experiences,
    yearsOfExperience: years,
    resumeSummary: lines.length ? lines.join('. ') : null,
  };
}

/**
 * Merge résumé fields into a candidate profile the viewer is already allowed to see.
 * Nulls go to `missing` and are omitted from `fields` (same as fieldProjector).
 */
export function mergeCandidateResume(candidateProfile, doc, now = new Date()) {
  const resume = candidateResumeFromDoc(doc, now);
  const fields = { ...(candidateProfile.fields || {}) };
  const visible = new Set(candidateProfile.visibleFields || []);
  const missing = new Set(candidateProfile.missing || []);
  for (const key of RESUME_KEYS) {
    const value = resume[key];
    if (value == null || value === '') {
      missing.add(key);
      visible.delete(key);
      delete fields[key];
    } else {
      fields[key] = value;
      visible.add(key);
      missing.delete(key);
    }
  }
  const sections = new Set(candidateProfile.sections || []);
  if (fields.skills) sections.add('skills');
  if (fields.qualifications) sections.add('education');
  if (fields.experiences || fields.yearsOfExperience != null) sections.add('experience');
  return {
    ...candidateProfile,
    fields,
    visibleFields: [...visible],
    missing: [...missing],
    sections: [...sections],
  };
}
