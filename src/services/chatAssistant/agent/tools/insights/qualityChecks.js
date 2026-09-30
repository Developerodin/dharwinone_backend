import JobApplicationModel from '../../../../../models/jobApplication.model.js';
import OfferModel from '../../../../../models/offer.model.js';
import TrainingModuleModel from '../../../../../models/trainingModule.model.js';
import UserModel from '../../../../../models/user.model.js';
import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { buildApplicantQuery as realBuildApplicantQuery } from '../../../../applicantQuery.service.js';
import { buildOfferVisibilityClause as realBuildOfferVisibilityClause } from '../../../../offer.service.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { EMPLOYEES_ACCESS, personRecordsDeps } from '../employees/common.js';
import { OFFERS_ACCESS, canSeeOfferCompensation as realCanSeeOfferCompensation } from '../hiring/common.js';
import { PROJECTS_ACCESS, projectFilterFor, workDeps } from '../projects/common.js';
import { APPLICATIONS_PAGE_PERMISSION } from '../calls/followups.js';
import { NOT_CAPTURED, runSection, sectionFrom } from './common.js';
import { ownsProfile } from '../ownsProfile.js';

/** Injectable seam — ctx.deps overrides for tests; tests never touch Mongo. */
export function qualityDeps(ctx) {
  const d = ctx?.deps || {};
  const work = workDeps(ctx);
  return {
    ...personRecordsDeps(ctx),
    User: d.User ?? UserModel,
    queryProjects: work.queryProjects,
    isAdmin: work.isAdmin,
    JobApplication: d.JobApplication ?? JobApplicationModel,
    Offer: d.Offer ?? OfferModel,
    TrainingModule: d.TrainingModule ?? TrainingModuleModel,
    buildApplicantQuery: d.buildApplicantQuery ?? realBuildApplicantQuery,
    buildOfferVisibilityClause: d.buildOfferVisibilityClause ?? realBuildOfferVisibilityClause,
    canSeeOfferCompensation: d.canSeeOfferCompensation ?? realCanSeeOfferCompensation,
  };
}

const allowed = async (rule, env) => (await checkAccessRule(rule, env.user, env.ctx?.deps)).ok;
const limitFor = (n) => Math.max(1, n);

// Rows one population scan reads; past it the count is a lower bound (atLeast).
const PEOPLE_SCAN_CAP = 5000;

/**
 * Employees / Candidates page population + one field clause.
 * ponytail: no Wave 1 tool filters on these fields. Same authorize → scope → mongo filter chain as
 * get_allocation's loadPopulation (the page's own list scope), wrapped in $and with the clause.
 *
 * The page picks people by their owner LOGIN's role, but a public-apply candidate profile is owned by the job
 * creator (ownsProfile.js). Such a profile is not the creator — so it never counts as an Employee-role person —
 * and it is a candidate even though the creator holds no Candidate role, so candidate checks add them back
 * from the same scope without the role clause. Rows are read (owner + email) to apply that rule, capped at
 * PEOPLE_SCAN_CAP per scan; upgrade = store an `ownsOwner` flag on Employee and count in Mongo.
 */
async function peopleCheck(env, ownerUserRole, clause, extraFields = '', row = () => ({})) {
  const { user, deps, sampleSize } = env;
  if (!(await allowed(EMPLOYEES_ACCESS, env))) return { status: 'restricted' };
  const filters = { ownerUserRole };
  const auth = deps.authorizeEmployeeQuery({ entity: 'employees', operations: ['count'], filters }, user);
  if (!auth?.allowed) return { status: 'restricted' };
  const apiFilter = await deps.applyEmployeeListScope(toApiFilter(filters), user, user.authContext);
  const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
  const fields = `owner email fullName employeeId ${extraFields}`.trim();
  const scan = (filter) => deps.Employee.find({ $and: [filter, clause] }).select(fields)
    .sort({ fullName: 1 }).limit(PEOPLE_SCAN_CAP + 1).lean();
  // The role clause is mongoFilter.owner only when the viewer's own scope did not already pin owner (self-only).
  const withoutRole = { ...mongoFilter };
  delete withoutRole.owner;
  const [roleRows, applicantRows] = await Promise.all([
    scan(mongoFilter),
    ownerUserRole === CANDIDATE && !apiFilter.owner ? scan(withoutRole) : [],
  ]);
  const owns = await ownsProfile([...roleRows, ...applicantRows], deps);
  const seen = new Set();
  const people = [...roleRows.filter(owns), ...applicantRows.filter((e) => !owns(e))]
    .filter((r) => {
      const key = r._id != null ? String(r._id) : r;
      return !seen.has(key) && seen.add(key);
    });
  const atLeast = roleRows.length > PEOPLE_SCAN_CAP || applicantRows.length > PEOPLE_SCAN_CAP;
  return {
    status: 'ok',
    count: people.length,
    ...(atLeast ? { atLeast: true, note: `More than ${PEOPLE_SCAN_CAP} profiles matched; this is a lower bound.` } : {}),
    sample: people.slice(0, sampleSize).map((r) => ({ name: r.fullName ?? null, employeeId: r.employeeId ?? null, ...row(r) })),
  };
}

async function toolCheck(env, name, args, pick) {
  return sectionFrom(await runSection(name, args, env.ctx), pick);
}

/** find_duplicate_people: `{ totalGroups, groups: [{ matchedOn, size, people: [{ id, name }] }], emailNote? }`. */
function duplicatePick(n) {
  return (r) => {
    if (typeof r.totalGroups !== 'number') return { status: 'error', error: 'find_duplicate_people returned no totalGroups.' };
    return {
      count: r.totalGroups,
      ...(r.emailNote ? { note: r.emailNote } : {}),
      sample: (r.groups || []).slice(0, n).map((g) => ({
        matchedOn: g.matchedOn ?? null,
        people: (g.people || []).slice(0, 5).map((p) => p?.name ?? '(no name)').join(', '),
      })),
    };
  };
}

async function applicationsNoReferral(env) {
  const { user, deps, sampleSize } = env;
  if (!(await allowed({ anyOf: [APPLICATIONS_PAGE_PERMISSION] }, env))) return { status: 'restricted' };
  const { query } = await deps.buildApplicantQuery({ excludeInternal: true }, user);
  // count_applications / list_applications have no referral filter, and the referral lives on the candidate
  // (Employee.referredByUserId), not the application. Scope is the Applications page's own buildApplicantQuery.
  // ponytail: referred profiles are few (referral leads), so their ids go into one $nin; past ~50k referred
  // profiles move this into a $lookup aggregate.
  const referred = await deps.Employee.find({ referredByUserId: { $ne: null } }).distinct('_id');
  const match = { $and: [query, { candidate: { $nin: referred } }] };
  const [count, rows] = await Promise.all([
    deps.JobApplication.countDocuments(match),
    sampleSize
      ? deps.JobApplication.find(match).select('candidate job status').sort({ createdAt: -1 }).limit(sampleSize)
        .populate({ path: 'candidate', select: 'fullName' }).populate({ path: 'job', select: 'title' }).lean()
      : [],
  ]);
  return {
    status: 'ok',
    count,
    sample: rows.map((r) => ({ applicant: r.candidate?.fullName ?? null, job: r.job?.title ?? null, status: r.status ?? null })),
  };
}

const NO_JOINING = { joiningDate: null };
// Unpaid offers legitimately carry no salary, so they never count as "missing salary".
const NO_SALARY = { compensationType: { $ne: 'unpaid' }, $or: [{ 'ctcBreakdown.gross': null }, { 'ctcBreakdown.gross': { $lte: 0 } }] };

async function offersMissingTerms(env) {
  const { user, deps, sampleSize } = env;
  if (!(await allowed(OFFERS_ACCESS, env))) return { status: 'restricted' };
  // ponytail: count_offers / list_offers have no missing-field filter and queryOffers takes page filter keys
  // only. buildOfferVisibilityClause is the Offers page's own row scope (exported from offer.service for Sage);
  // this is that scope + one $and clause.
  const vis = await deps.buildOfferVisibilityClause(user);
  const showSalary = await deps.canSeeOfferCompensation(user);
  const parts = { missingJoiningDate: 0, missingSalary: showSalary ? 0 : 'restricted' };
  if (vis.blocked) return { status: 'ok', count: 0, parts, sample: [] };
  const scope = vis.orClause ?? (vis.createdBy ? { createdBy: vis.createdBy } : {});
  // Drafts are still being written, so missing terms there are expected, not a data gap.
  const base = { status: { $nin: ['Rejected', 'Draft'] } };
  const match = (clause) => ({ $and: [scope, base, clause] });
  const either = showSalary ? { $or: [NO_JOINING, NO_SALARY] } : NO_JOINING;
  const [joining, salary, union, rows] = await Promise.all([
    deps.Offer.countDocuments(match(NO_JOINING)),
    showSalary ? deps.Offer.countDocuments(match(NO_SALARY)) : null,
    showSalary ? deps.Offer.countDocuments(match(either)) : null,
    sampleSize
      ? deps.Offer.find(match(either)).select('offerCode status joiningDate compensationType ctcBreakdown.gross candidate')
        .populate({ path: 'candidate', select: 'fullName' }).sort({ createdAt: -1 }).limit(sampleSize).lean()
      : [],
  ]);
  return {
    status: 'ok',
    count: showSalary ? union : joining,
    parts: { missingJoiningDate: joining, missingSalary: showSalary ? salary : 'restricted' },
    sample: rows.map((o) => {
      const missing = [];
      if (!o.joiningDate) missing.push('joining date');
      if (showSalary && o.compensationType !== 'unpaid' && !(o.ctcBreakdown?.gross > 0)) missing.push('salary');
      return { candidate: o.candidate?.fullName ?? null, offerCode: o.offerCode ?? null, status: o.status ?? null, missing: missing.join(', ') };
    }),
  };
}

// GET /training/modules (trainingModule.route.js): the course list itself.
const COURSES_ACCESS = Object.freeze({ anyOf: ['modules.read', 'categories.read', 'positions.read'] });

async function coursesNoPosition(env) {
  const { deps, sampleSize } = env;
  if (!(await allowed(COURSES_ACCESS, env))) return { status: 'restricted' };
  // The position_map call is the access gate (the Curriculum Setup roster permission) and the source of positions.
  const gate = await toolCheck(env, 'get_training_progress', { mode: 'position_map', limit: 1 }, (r) => ({ positions: r.total ?? null }));
  if (gate.status !== 'ok') return gate;
  // ponytail: position_map lists positions → courses (30 per position, 50 positions per call), so inverting its
  // rows is not exact. The mapping it reads is TrainingModule.positions (position.service buildModulesByPositionId),
  // an org-wide catalogue with no row scope; read here under the same gate, draft + published courses.
  const match = { status: { $ne: 'archived' }, 'positions.0': { $exists: false } };
  const [count, rows] = await Promise.all([
    deps.TrainingModule.countDocuments(match),
    sampleSize ? deps.TrainingModule.find(match).select('moduleName status').sort({ moduleName: 1 }).limit(sampleSize).lean() : [],
  ]);
  return { status: 'ok', count, positions: gate.positions, sample: rows.map((m) => ({ course: m.moduleName ?? null, status: m.status ?? null })) };
}

async function projectsNoManager(env) {
  const { user, deps, sampleSize } = env;
  if (!(await allowed(PROJECTS_ACCESS, env))) return { status: 'restricted' };
  // ponytail: count_projects / list_projects have no manager filter. Same filter the Projects page uses
  // (projectFilterFor → queryProjects; My Projects without projects.read) plus one field clause.
  const { filter, scope } = await projectFilterFor(user, {}, deps);
  filter.projectManager = { $in: [null, ''] };
  const res = await deps.queryProjects(filter, { limit: limitFor(sampleSize) });
  return {
    status: 'ok',
    count: res?.totalResults ?? 0,
    scope,
    sample: (res?.results || []).slice(0, sampleSize).map((p) => ({ name: p.name ?? null, status: p.status ?? null })),
  };
}

const EMPLOYEE = 'employee';
const CANDIDATE = 'candidate';

/** The 17 BRD AA checks, in BRD order. `run(env)` never needs to catch: the tool wraps every check. */
export const QUALITY_CHECKS = Object.freeze([
  {
    id: 'incomplete_employee_profiles',
    label: 'Employee profiles not 100% complete',
    source: 'Employee.isProfileCompleted below 100, the completion % the portal stores on save ' +
      '(employee.service calculateProfileCompletion: 30% for name, email and phone, +10% personal details, +10% each ' +
      'for qualifications, experiences, skills, documents, social links and salary slips). Current employees you can see.',
    run: (env) => peopleCheck(env, EMPLOYEE, { isProfileCompleted: { $not: { $gte: 100 } } }, 'isProfileCompleted',
      (r) => ({ profileCompletion: r.isProfileCompleted ?? 0 })),
  },
  {
    id: 'candidates_no_skills',
    label: 'Candidates with no skills',
    source: 'Candidate profiles you can see with no Employee.skills entry.',
    run: (env) => peopleCheck(env, CANDIDATE, { 'skills.0': { $exists: false } }),
  },
  {
    id: 'candidates_no_education',
    label: 'Candidates with no education',
    source: 'Candidate profiles you can see with no Employee.qualifications entry.',
    run: (env) => peopleCheck(env, CANDIDATE, { 'qualifications.0': { $exists: false } }),
  },
  {
    id: 'candidates_no_experience',
    label: 'Candidates with no work experience',
    source: 'Candidate profiles you can see with no Employee.experiences entry.',
    run: (env) => peopleCheck(env, CANDIDATE, { 'experiences.0': { $exists: false } }),
  },
  {
    id: 'employees_no_agent',
    label: 'Employees with no assigned agent',
    source: 'Current employees you can see with no Employee.assignedAgent (training staff, Settings → Agents).',
    run: (env) => peopleCheck(env, EMPLOYEE, { assignedAgent: null }),
  },
  {
    id: 'duplicate_phones',
    label: 'Duplicate phone numbers',
    source: 'find_duplicate_people by phone (digits only, last 10) across candidates and employees; count = groups.',
    run: (env) => toolCheck(env, 'find_duplicate_people', { by: 'phone', population: 'all', limit: limitFor(env.sampleSize) },
      duplicatePick(env.sampleSize)),
  },
  {
    id: 'duplicate_emails',
    label: 'Duplicate emails',
    source: 'find_duplicate_people by email (lower-case, trimmed) across candidates and employees; count = groups.',
    run: (env) => toolCheck(env, 'find_duplicate_people', { by: 'email', population: 'all', limit: limitFor(env.sampleSize) },
      duplicatePick(env.sampleSize)),
  },
  {
    id: 'applications_no_referral',
    label: 'Applications with no source or referral',
    source: `An application's source is ${NOT_CAPTURED}; this counts applications (Applications page scope) whose ` +
      'candidate has no referral (Employee.referredByUserId).',
    run: applicationsNoReferral,
  },
  {
    id: 'interviews_no_result',
    label: 'Interviews with no result',
    source: 'list_interviews resultMissing: ended interviews whose result is still pending.',
    run: (env) => toolCheck(env, 'list_interviews', { filters: { resultMissing: true }, limit: limitFor(env.sampleSize) }, (r) => ({
      count: r.total ?? 0,
      sample: (r.records || []).slice(0, env.sampleSize)
        .map((i) => ({ candidate: i.candidate ?? null, jobPosition: i.jobPosition ?? null, scheduledAt: i.scheduledAt ?? null })),
    })),
  },
  {
    id: 'offers_missing_terms',
    label: 'Offers missing salary or joining date',
    source: 'Offers you can see, not Rejected or Draft, with no joiningDate or (for paid offers) no gross CTC. The salary part ' +
      'needs the Offer Letter Generator permission; without it that part is restricted.',
    run: offersMissingTerms,
  },
  {
    id: 'employees_no_department',
    label: 'Employees with no department',
    source: 'count_employees groupBy department, the "Not set" group (Employee.department text field).',
    run: (env) => toolCheck(env, 'count_employees', { groupBy: 'department' }, (r) => {
      const notSet = (r.groups || []).find((g) => g.value === 'Not set');
      if (!notSet && r.otherCount) {
        return { status: 'error', error: 'The department breakdown was cut at 25 groups, so "Not set" was not returned.' };
      }
      return { count: notSet?.count ?? 0, sample: [], note: 'The breakdown gives a count only, no names.' };
    }),
  },
  {
    id: 'employees_no_group',
    label: 'Employees in no org-chart group',
    source: 'get_reporting_chain no_group: active employees in no org-chart department.',
    run: (env) => toolCheck(env, 'get_reporting_chain', { mode: 'no_group', limit: limitFor(env.sampleSize) }, (r) => ({
      count: r.total ?? 0,
      sample: (r.records || []).slice(0, env.sampleSize).map((e) => ({ name: e.name ?? null, designation: e.designation ?? null })),
    })),
  },
  {
    id: 'courses_no_position',
    label: 'Courses mapped to no position',
    source: 'Training courses (draft or published) with no position in Curriculum Setup (TrainingModule.positions).',
    run: coursesNoPosition,
  },
  {
    id: 'tasks_no_assignee',
    label: 'Tasks with no assignee',
    source: 'list_tasks unassigned on the Task Board. Needs the org-wide board (tasks.read): your own tasks always have you.',
    run: (env) => toolCheck(env, 'list_tasks', { filters: { unassigned: true }, limit: limitFor(env.sampleSize) }, (r) => {
      if (r.scope === 'mine') return { status: 'restricted' };
      return { count: r.total ?? 0, sample: (r.records || []).slice(0, env.sampleSize).map((t) => ({ code: t.code ?? null, title: t.title ?? null, status: t.status ?? null })) };
    }),
  },
  {
    id: 'tasks_no_due_date',
    label: 'Tasks with no due date',
    source: 'list_tasks noDueDate on the Task Board (your own tasks only without tasks.read).',
    run: (env) => toolCheck(env, 'list_tasks', { filters: { noDueDate: true }, limit: limitFor(env.sampleSize) }, (r) => ({
      count: r.total ?? 0,
      scope: r.scope ?? null,
      sample: (r.records || []).slice(0, env.sampleSize).map((t) => ({ code: t.code ?? null, title: t.title ?? null, status: t.status ?? null })),
    })),
  },
  {
    id: 'projects_no_manager',
    label: 'Projects with no manager',
    source: 'Projects you can see with an empty Project.projectManager (a free-text name, not a user link).',
    run: projectsNoManager,
  },
  {
    id: 'expired_documents',
    label: 'Expired documents',
    source: 'list_documents cohort (people on the Pre-boarding / Onboarding pages, Cancelled left out): EAD or visa ' +
      'expiry before today, the only documents with an expiry date.',
    run: (env) => toolCheck(env, 'list_documents', { cohort: {}, onlyWith: 'expiring', expiringWithinDays: 1, limit: 50 }, (r) => {
      const records = r.records || [];
      const expired = records.filter((p) => (p.expiries || []).some((e) => e.expired));
      const complete = (r.total ?? 0) <= records.length && !r.scanTruncated;
      return {
        count: expired.length,
        ...(complete ? {} : { atLeast: true, note: 'More people have an EAD / visa expiring or expired than one call lists; this is a lower bound.' }),
        sample: expired.slice(0, env.sampleSize).map((p) => ({
          name: p.name ?? null,
          employeeId: p.employeeId ?? null,
          expired: p.expiries.filter((e) => e.expired).map((e) => `${e.document} ${e.expiresOn}`).join(', '),
        })),
      };
    }),
  },
]);

export const CHECK_IDS = QUALITY_CHECKS.map((c) => c.id);
