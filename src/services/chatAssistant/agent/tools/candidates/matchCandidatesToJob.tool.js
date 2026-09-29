import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { andMongoFilters } from '../../../queryPlanner/entities/jobRank.js';
import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { embedQuery as realEmbedQuery } from '../../../../../utils/embedding.util.js';
import { pineconeQuery as realPineconeQuery } from '../../../../../utils/pinecone.util.js';
import { jobScope } from '../jobs/common.js';
import { OBJECT_ID_RE } from '../people/common.js';
import { EMPLOYEES_ACCESS, personRecordsScope, personRecordsDeps } from '../employees/common.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
// ponytail: the vector index holds candidates AND employees, and row scope drops more, so ask
// Pinecone for 3x the rows. A pool much smaller than the index can still come back short —
// move the role into the Pinecone metadata filter if that shows up.
const OVERFETCH = 3;

/** 70% skill overlap with the job + 30% vector similarity, as a 0–100 percentage. */
export function scoreMatch(candidateSkills, jobSkills, pineconeScore) {
  if (!jobSkills?.length) return Math.round((pineconeScore ?? 0) * 100);
  const cSkills = new Set((candidateSkills ?? []).map((s) => String(s).toLowerCase()));
  const jSkills = (jobSkills ?? []).map((s) => String(s).toLowerCase());
  const overlap = jSkills.filter((s) => cSkills.has(s)).length;
  return Math.round((overlap / jSkills.length) * 70 + (pineconeScore ?? 0) * 30);
}

export default defineTool({
  name: 'match_candidates_to_job',
  domain: 'candidates',
  kind: 'read',
  description:
    'Rank the people who best fit one job posting by skills and profile similarity, with a match %. Use for ' +
    '"who fits this role", "best candidates for <job>", "suggest candidates for job X". pool "employees" ranks ' +
    'current employees instead (internal moves). Takes the job title directly — no need to find the job first.',
  measure:
    'Candidate (or, with pool "employees", current Employee) PROFILES you can see, ranked against one job ' +
      'posting you can see on the Jobs page. A ranking, not a count of everyone who qualifies.',
  input: Joi.object({
    jobId: Joi.string().description('Job id from an earlier job tool result.'),
    jobTitle: Joi.string().min(1).description('Job title, partial match. Prefer jobId when you have it.'),
    pool: Joi.string().valid('candidates', 'employees').default('candidates'),
    limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  }).or('jobId', 'jobTitle'),
  access: EMPLOYEES_ACCESS,
  async execute({ jobId, jobTitle, pool = 'candidates', limit = DEFAULT_LIMIT } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    const embedQuery = ctx.deps?.embedQuery ?? realEmbedQuery;
    const pineconeQuery = ctx.deps?.pineconeQuery ?? realPineconeQuery;

    // Same visibility as the Jobs page: a job the viewer can't see must not leak its title here.
    const { Job, visibilityFilter } = await jobScope(ctx);
    let jobMatch = null;
    if (jobId) jobMatch = OBJECT_ID_RE.test(jobId) ? { _id: jobId } : null;
    else jobMatch = { title: { $regex: jobTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
    const job = jobMatch
      ? await Job.findOne(andMongoFilters(jobMatch, visibilityFilter)).select('title skillTags skillRequirements').lean()
      : null;
    if (!job) return { error: 'Job not found (or not visible to you).' };

    const jobSkills = [...(job.skillTags ?? []), ...(job.skillRequirements ?? []).map((r) => r.name)].filter(Boolean);
    let hits;
    try {
      const vector = await embedQuery(`${job.title} ${jobSkills.join(' ')}`);
      hits = await pineconeQuery('employees', vector, limit * OVERFETCH, null);
    } catch {
      return { error: 'Profile matching is unavailable right now.', job: job.title };
    }
    const scoreByOwner = new Map(hits.map((m) => [m.metadata?.mongoId, m.score ?? 0]).filter(([id]) => id));
    if (!scoreByOwner.size) return { job: job.title, jobId: String(job._id), pool, candidates: [] };

    // Role + row scope exactly as list_candidates / list_employees: Candidate and Employee are
    // distinct roles, never mixed in one ranking.
    const roleFilter = pool === 'employees'
      ? { ownerUserRole: 'employee', employmentStatus: 'current' }
      : { ownerUserRole: 'candidate', employmentStatus: 'all' };
    const apiFilter = await deps.applyEmployeeListScope(toApiFilter(roleFilter), user, user.authContext);
    const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
    const people = await deps.Employee.find(andMongoFilters(mongoFilter, { owner: { $in: [...scoreByOwner.keys()] } }))
      .select('fullName email skills owner')
      .lean();

    const ranked = people.map((p) => {
      const userId = String(p.owner?._id ?? p.owner ?? '');
      // Employee.skills are objects ({ name, level }); score on names.
      const skills = (p.skills ?? []).map((s) => s?.name).filter(Boolean);
      return {
        name: p.fullName ?? null,
        email: p.email ?? null,
        skills,
        matchPct: scoreMatch(skills, jobSkills, scoreByOwner.get(userId)),
        userId,
      };
    }).sort((a, b) => b.matchPct - a.matchPct).slice(0, limit);

    return { job: job.title, jobId: String(job._id), pool, candidates: ranked };
  },
  render(result) {
    if (!result?.candidates?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'job-match',
        tableType: 'job-match',
        title: `Best ${result.pool} for ${result.job}`,
        columns: [
          { key: 'name', label: 'Name', priority: 'primary' },
          { key: 'matchPct', label: 'Match %', priority: 'primary', format: 'number' },
          { key: 'skills', label: 'Skills', priority: 'secondary' },
        ],
        rows: result.candidates.map((c) => ({
          name: c.name ?? '—',
          matchPct: String(c.matchPct),
          skills: c.skills.slice(0, 6).join(', ') || '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
