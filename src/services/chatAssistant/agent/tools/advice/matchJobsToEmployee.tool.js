import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { EMPLOYEES_ACCESS, personRecordsDeps } from '../employees/common.js';
import { ADVICE_ACCESS, MAX_LIST_LIMIT, SECTION_ROWS, adviceDeps, adviceScope, clampLimit, normName, sectionStatus } from './common.js';

const MAX_MATCHES = 6;
const MAX_SEARCH_TERMS = 10;
const SKILL_WEIGHT = 80;
const TITLE_WEIGHT = 20;

/** Skill overlap on the job's skill tags (80) + 20 when the job title and the designation contain each other. */
export function scoreJob(job, skills, designation) {
  const mine = new Set(skills.map(normName));
  const tags = [...new Set((job.skillTags || []).map(normName).filter(Boolean))];
  const matched = tags.filter((t) => mine.has(t));
  const missing = tags.filter((t) => !mine.has(t));
  const title = normName(job.title);
  const des = normName(designation);
  const titleMatch = !!des && !!title && (title.includes(des) || des.includes(title));
  const score = Math.round((tags.length ? (matched.length / tags.length) * SKILL_WEIGHT : 0) + (titleMatch ? TITLE_WEIGHT : 0));
  return { score, matchedSkills: matched, missingSkills: missing, titleMatch, noSkillTags: tags.length === 0 };
}

/**
 * The person's own Employee profile through the Employees page's toolbar search and row scope.
 * ponytail: get_user only carries a 5-skill summary string and list_employees returns no skills,
 * so no tool gives the full skill list — this is the Employees page filter (buildEmployeeListMongoFilter,
 * which runs the page's own profile top-up) + applyEmployeeListScope, with an explicit projection.
 */
async function loadEmployee(person, user, deps) {
  const apiFilter = await deps.applyEmployeeListScope(
    toApiFilter({ ownerUserRole: 'employee', employmentStatus: 'current', search: person }), user, user.authContext,
  );
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const rows = await deps.Employee.find(mongoFilter).select('fullName designation skills').limit(MAX_MATCHES).lean();
  const exact = rows.filter((r) => normName(r.fullName) === normName(person));
  const pool = exact.length ? exact : rows;
  if (pool.length === 1) return { employee: pool[0] };
  if (pool.length > 1) return { matches: pool.map((r) => r.fullName ?? null) };
  return { notFound: true };
}

export default defineTool({
  name: 'match_jobs_to_employee',
  domain: 'advice',
  kind: 'read',
  description:
    'The reverse of match_candidates_to_job: which open jobs fit one current employee, ranked by how many of ' +
    'the job\'s skill tags they have, with the skills they have and the ones they are missing per job. Use for ' +
    '"which jobs suit X", "internal openings for X", "what could X move to", "skill gap for X". Not for ranking ' +
    'people for one job (match_candidates_to_job) and not for candidates (Candidate profiles are not employees).',
  measure:
    'Keyword / skill-tag overlap between the employee\'s profile skills and active jobs you can see on the Jobs ' +
    'page — not semantic similarity (the vector index only holds people, not jobs). Jobs with no skill tags can ' +
    'only match on title vs designation.',
  input: Joi.object({
    person: Joi.string().trim().min(1).max(120).required().description('Employee name or employee id.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: ADVICE_ACCESS,
  timeoutMs: 10000,
  async execute({ person, limit }, ctx) {
    const user = adviceScope(ctx);
    const { run } = adviceDeps(ctx);
    if (!(await checkAccessRule(EMPLOYEES_ACCESS, user)).ok) {
      return { person, sections: { profile: 'restricted' }, jobs: [], total: 0 };
    }
    const who = await loadEmployee(person, user, personRecordsDeps(ctx));
    if (who.matches) return { person, matches: who.matches, sections: { profile: 'ok' } };
    if (who.notFound) {
      return { person, noEmployeeProfile: true, note: 'No current employee by that name in your Employees list.', sections: { profile: 'ok' } };
    }
    const emp = who.employee;
    const skills = [...new Set((emp.skills || []).map((s) => s?.name).filter(Boolean))];
    const designation = emp.designation ?? null;
    const searchSkills = skills.slice(0, MAX_SEARCH_TERMS - (designation ? 1 : 0));
    const terms = [...searchSkills, ...(designation ? [designation] : [])];
    const base = { person: emp.fullName ?? person, designation, skills: skills.slice(0, 15), skillsTotal: skills.length };
    if (!terms.length) {
      return { ...base, jobs: [], total: 0, note: 'No skills or designation on their profile — not captured in DharwinOne.', sections: { profile: 'ok' } };
    }

    // Internal only: external jobs are other companies' mirrored listings, not openings to move someone into.
    const out = await run('list_jobs', { filters: { search: terms, jobOrigin: 'internal' }, limit: MAX_LIST_LIMIT }, { timeoutMs: 8000 });
    const jobsSection = sectionStatus(out);
    if (jobsSection.status !== 'ok') return { ...base, jobs: [], total: 0, sections: { profile: 'ok', jobs: jobsSection.status } };
    const list = out.result.jobs || [];
    const ranked = list
      .map((j) => ({ job: j, ...scoreJob(j, skills, designation) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || String(a.job.title).localeCompare(String(b.job.title)));
    return {
      ...base,
      total: ranked.length,
      jobsSearched: list.length,
      ...(out.result.total > list.length ? { searchTruncated: `Only the first ${list.length} of ${out.result.total} matching jobs were scored.` } : {}),
      ...(skills.length > searchSkills.length ? { searchTermsUsed: terms } : {}),
      jobs: ranked.slice(0, clampLimit(limit)).map((r) => ({
        jobId: r.job.jobId,
        title: r.job.title ?? null,
        organisation: r.job.organisation?.name ?? null,
        score: r.score,
        matchedSkills: r.matchedSkills.slice(0, 10),
        missingSkills: r.missingSkills.slice(0, 10),
        ...(r.titleMatch ? { titleMatchesDesignation: true } : {}),
        ...(r.noSkillTags ? { note: 'Job has no skill tags.' } : {}),
      })),
      sections: { profile: 'ok', jobs: 'ok' },
    };
  },
  render(result) {
    if (!result?.jobs?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'jobs-for-employee',
        tableType: 'jobs-for-employee',
        title: `Jobs for ${result.person} (${result.total})`,
        columns: [
          { key: 'title', label: 'Job', priority: 'primary' },
          { key: 'score', label: 'Score', priority: 'primary' },
          { key: 'matched', label: 'Has', priority: 'secondary' },
          { key: 'missing', label: 'Missing', priority: 'secondary' },
        ],
        rows: result.jobs.map((j) => ({
          title: j.title ?? '—',
          score: String(j.score),
          matched: j.matchedSkills.slice(0, SECTION_ROWS).join(', ') || '—',
          missing: j.missingSkills.slice(0, SECTION_ROWS).join(', ') || '—',
        })),
        layout: 'auto',
      }],
      facts: { counts: [{ kind: 'match_jobs_to_employee', label: 'jobs', total: result.total }] },
    };
  },
});
