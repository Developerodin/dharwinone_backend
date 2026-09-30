/**
 * Pure rule evaluators for explain_status. Each rule restates a condition the code actually enforces and
 * names that code in `source`; `met` is true / false, or null when the section that would prove it was
 * restricted, failed, or the value is not captured. Inputs are compose.runTool outcomes — never raw rows.
 */
import { isAllowedTransition } from '../../../../../constants/atsPipeline.js';
import { isPreboardingGateSatisfied } from '../../../../placement.service.js';
import { joinCalendarDayHasArrived } from '../../../../employeeRolePromotion.service.js';
import { MAX_ACTIVE_PROJECTS_PER_ASSIGNEE } from '../../../../projectCapacity.js';
import { NOT_CAPTURED, SECTION_ROWS, normName, rule, sectionStatus } from './common.js';

export const SOURCES = Object.freeze({
  resigned: 'personProfile/providers/employee.js employmentStatus (utils/resignBucket.js resignationCutoff)',
  profileRecord: 'employee.service.js buildEmployeeListMongoFilter (Employee document owned by the login)',
  employeeRole: 'employee.service.js ensureProfilesForActiveAtsRoleUsers("employee") — owner holds the Employee role',
  accountStatus: 'employee.service.js ensureProfilesForActiveAtsRoleUsers — owner account active or pending',
  listScope: 'schemas/employees/employeeQuery.scope.js applyEmployeeListScope',
  promotion: 'placement.service.js tryPromotePlacementCandidateIfEligible + employeeRolePromotion.service.js joinCalendarDayHasArrived',
  capacity: 'services/projectCapacity.js isAtProjectCapacity',
  leaveToday: 'onLeaveToday.service.js getEmployeesOnLeaveToday',
  joined: 'hiring/placementDetail.js placement status (get_placement)',
  transition: 'constants/atsPipeline.js isAllowedTransition("placement", …)',
  preboardingGate: 'placement.service.js isPreboardingGateSatisfied (enforced by updatePlacementStatus)',
  gateBypass: 'placement.controller.js update — preboarding.override or candidates.manage',
  chartSearch: 'orgStructure.service.js searchOrgChart (Employee.isActive ≠ false, owner holds the Employee role)',
  chartDepartment: 'orgStructure.service.js searchOrgChart paths (departmentId → a department unit)',
});

const CAPACITY_TEXT = `Under the active-project limit (fewer than ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE} active projects elsewhere)`;

/** Why a section could not prove a rule — names the section, never its data (rule 5). */
export function sectionEvidence(section, label) {
  switch (section?.status) {
    case 'restricted': return `You may not see ${label}.`;
    case 'timeout': return `The ${label} check timed out.`;
    case 'error': return `The ${label} check failed.`;
    default: return null;
  }
}

/** get_user outcome → the facts the rules read. `matches` set = stop and disambiguate. */
export function profileFacts(out) {
  const section = sectionStatus(out);
  if (section.status !== 'ok') return { section };
  const r = out.result;
  if (Array.isArray(r.matches)) return { section, matches: r.matches };
  const roleNames = (r.roles || []).map((x) => x?.name).filter(Boolean);
  const roleSet = new Set([...roleNames, ...(r.identity?.roles || [])].map(normName));
  const outOfScope = r.profileNote === 'employee/candidate profile not visible to you';
  const notPermitted = r.profileNote === 'not permitted';
  const emp = r.profiles?.employee;
  const cand = r.profiles?.candidate;
  const doc = emp ?? cand;
  const redacted = new Set(doc?.redacted || []);
  let employmentStatus = null;
  if (emp && !emp.noRecord && !emp.error && !redacted.has('employmentStatus')) {
    employmentStatus = emp.fields?.employmentStatus ?? null;
  }
  return {
    section,
    name: r.identity?.name ?? null,
    userId: r.identity?.userId ?? null,
    hasEmployeeRole: roleSet.has('employee'),
    hasCandidateRole: roleSet.has('candidate'),
    // null = cannot tell (stripped by row scope, not permitted, or the provider failed to load).
    hasProfileRecord: outOfScope || notPermitted || doc?.error ? null : doc ? !doc.noRecord : false,
    employmentStatus,
    employmentStatusHidden: redacted.has('employmentStatus'),
    outOfScope,
    notPermitted,
  };
}

export function resignedRule(pf) {
  const text = 'Not resigned (no resign date on or before today)';
  if (pf?.section?.status !== 'ok') return rule(text, SOURCES.resigned, null, sectionEvidence(pf?.section, 'the profile'));
  if (pf.employmentStatus === 'active') return rule(text, SOURCES.resigned, true, 'Employment status: active.');
  if (pf.employmentStatus === 'resigned') {
    return rule(text, SOURCES.resigned, false, 'Employment status: resigned (resign date on or before today).');
  }
  let why = `Employment status ${NOT_CAPTURED} for this person.`;
  if (pf.outOfScope) why = 'Their Employee profile is outside your Employees scope.';
  else if (pf.notPermitted) why = 'You may not read their profile.';
  else if (pf.employmentStatusHidden) why = 'Employment status is only shown with employees.manage.';
  else if (!pf.hasEmployeeRole) why = 'Not an Employee, so no resign date applies.';
  return rule(text, SOURCES.resigned, null, why);
}

/** who_is_on_leave_today outcome. Its scope may be 'self' / 'referrals', so a miss only proves "not on leave" at scope 'all'. */
export function leaveRule(out, name) {
  const text = 'Not on leave today';
  const section = sectionStatus(out);
  if (section.status !== 'ok') return rule(text, SOURCES.leaveToday, null, sectionEvidence(section, 'who is on leave today'));
  const { records = [], total = 0, scope } = out.result;
  const hits = records.filter((r) => normName(r.name) === normName(name));
  if (hits.length > 1) return rule(text, SOURCES.leaveToday, null, 'Several people with this name are on leave today.');
  if (hits.length === 1) {
    const h = hits[0];
    return rule(text, SOURCES.leaveToday, false, { leaveType: h.leaveType ?? null, from: h.from ?? null, to: h.to ?? null });
  }
  if (scope && scope !== 'all') {
    return rule(text, SOURCES.leaveToday, null, `Your leave-today view only covers ${scope === 'self' ? 'yourself' : 'your referrals'}.`);
  }
  return rule(text, SOURCES.leaveToday, true, `Not among the ${total} people on leave today.`);
}

/**
 * get_allocation list outcomes for the at-capacity buckets (projects_2, projects_3_plus). A miss only proves
 * "under the limit" when no list was truncated.
 */
export function capacityFromBuckets(outs, name) {
  let hits = [];
  let truncated = false;
  for (const out of outs) {
    const section = sectionStatus(out);
    if (section.status !== 'ok') return rule(CAPACITY_TEXT, SOURCES.capacity, null, sectionEvidence(section, 'project allocation'));
    const recs = out.result.records || [];
    if ((out.result.total ?? 0) > recs.length) truncated = true;
    hits = hits.concat(recs.filter((r) => normName(r.name) === normName(name)));
  }
  if (hits.length > 1) return rule(CAPACITY_TEXT, SOURCES.capacity, null, 'Several people with this name are at the project limit.');
  if (hits.length === 1) {
    return rule(CAPACITY_TEXT, SOURCES.capacity, false, {
      activeProjects: hits[0].activeProjects ?? null, max: MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
    });
  }
  if (truncated) return rule(CAPACITY_TEXT, SOURCES.capacity, null, 'The at-limit list was longer than the rows checked.');
  return rule(CAPACITY_TEXT, SOURCES.capacity, true, `Not on ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}+ active projects.`);
}

/** get_allocation can_assign outcome → { rule } or { matches } (ambiguous person / project). */
export function capacityFromCanAssign(out) {
  const section = sectionStatus(out);
  if (section.status !== 'ok') return { rule: rule(CAPACITY_TEXT, SOURCES.capacity, null, sectionEvidence(section, 'project allocation')) };
  const r = out.result;
  if (r.ambiguous) return { matches: { ambiguous: r.ambiguous, matches: (r.matches || []).slice(0, 10) } };
  if (r.notFound) {
    return { rule: rule(CAPACITY_TEXT, SOURCES.capacity, null, `No ${r.notFound} found for "${r.searchedFor ?? ''}".`) };
  }
  return {
    rule: rule(CAPACITY_TEXT, SOURCES.capacity, r.eligible ?? null, {
      reason: r.reason ?? null,
      project: r.project ?? null,
      projectStatus: r.projectStatus ?? null,
      activeProjectsElsewhere: r.activeProjectsElsewhere ?? null,
      alreadyOnProject: r.alreadyOnProject ?? null,
      max: r.maxActiveProjects ?? MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
    }),
  };
}

/** get_placement outcome → the placement facts the rules read. */
export function placementFacts(out) {
  const section = sectionStatus(out);
  if (section.status !== 'ok') {
    const noAccess = out?.status === 'ok' && /do not have access/i.test(out.result?.error || '');
    return { section, noAccess };
  }
  const r = out.result;
  if (r.matches) return { section, matches: r.matches.slice(0, 10) };
  if (r.notFound) return { section, notFound: true };
  const pre = (r.steps || []).find((s) => s.step === 'Pre-boarding') || {};
  return {
    section,
    found: true,
    status: r.status ?? null,
    joiningDate: r.joiningDate ?? null,
    holdsEmployeeRole: r.holdsEmployeeRole ?? null,
    firstBlockingStep: r.firstBlockingStep ?? null,
    preBoardingStatus: pre.status ?? null,
    preBoardingTasks: pre.tasks || [],
  };
}

function placementMiss(text, source, pl) {
  if (pl.section.status !== 'ok') return rule(text, source, null, sectionEvidence(pl.section, 'this placement'));
  if (pl.matches) return rule(text, source, null, 'Several placements match this name.');
  return rule(text, source, null, 'No placement you can see for this person.');
}

export function joinedRule(pl) {
  const text = 'Has joined (placement marked Joined)';
  if (!pl.found) return placementMiss(text, SOURCES.joined, pl);
  return rule(text, SOURCES.joined, pl.status === 'Joined', {
    placementStatus: pl.status, joiningDate: pl.joiningDate, firstBlockingStep: pl.firstBlockingStep,
  });
}

export function promotionRule(pl) {
  const text = 'Candidate becomes an Employee once the placement is Onboarding or Joined and the joining day has arrived';
  if (!pl.found) return placementMiss(text, SOURCES.promotion, pl);
  const statusOk = pl.status === 'Onboarding' || pl.status === 'Joined';
  const dayArrived = joinCalendarDayHasArrived(pl.joiningDate);
  return rule(text, SOURCES.promotion, statusOk && dayArrived, {
    placementStatus: pl.status, joiningDate: pl.joiningDate, joiningDayArrived: dayArrived, holdsEmployeeRole: pl.holdsEmployeeRole,
  });
}

export function transitionRule(pl) {
  const text = 'Placement status may move to Onboarding';
  if (!pl.found) return placementMiss(text, SOURCES.transition, pl);
  return rule(text, SOURCES.transition, isAllowedTransition('placement', pl.status, 'Onboarding'), { placementStatus: pl.status });
}

export function preboardingGateRule(pl) {
  const text = 'Pre-boarding gate: every required checklist step done (or pre-boarding Completed when there is no checklist)';
  if (!pl.found) return placementMiss(text, SOURCES.preboardingGate, pl);
  const tasks = pl.preBoardingTasks;
  const open = tasks.filter((t) => t.required && !t.done).map((t) => t.title);
  return rule(text, SOURCES.preboardingGate, isPreboardingGateSatisfied({ preBoardingTasks: tasks, preBoardingStatus: pl.preBoardingStatus }), {
    preBoardingStatus: pl.preBoardingStatus,
    openRequiredSteps: open.slice(0, SECTION_ROWS),
    openRequiredTotal: open.length,
    firstBlockingStep: pl.firstBlockingStep,
  });
}

/** The viewer's own bypass right — context, never a reason the person is blocked. */
export function gateBypassRule(canBypass) {
  return {
    ...rule('You can bypass the pre-boarding gate', SOURCES.gateBypass, canBypass,
      canBypass ? 'Your role has preboarding.override or candidates.manage.' : 'Needs preboarding.override or candidates.manage.'),
    viewer: true,
  };
}

export function employeeListRules(pf) {
  const ok = pf.section.status === 'ok';
  const miss = sectionEvidence(pf.section, 'this person\'s profile');
  const scopeMet = ok ? !(pf.outOfScope || pf.notPermitted) : null;
  return [
    rule('Has a profile record (Employee document owned by their login)', SOURCES.profileRecord,
      ok ? pf.hasProfileRecord : null, ok ? (pf.hasProfileRecord === null ? 'Cannot tell — their profile is hidden from you.' : null) : miss),
    rule('Their login holds the Employee role (Candidates are listed on the Candidates page)', SOURCES.employeeRole,
      ok ? pf.hasEmployeeRole : null, ok ? { candidateRole: pf.hasCandidateRole } : miss),
    rule('Their account is active or pending', SOURCES.accountStatus, null, `Account status is ${NOT_CAPTURED} for Sage — deleted accounts are never found at all.`),
    resignedRule(pf),
    rule('Inside your Employees-page scope', SOURCES.listScope, scopeMet,
      ok ? (pf.outOfScope ? 'Their profile is outside your scope (agents see assigned people, sales agents their referrals).' : pf.notPermitted ? 'You may not read their profile.' : null) : miss),
  ];
}

/** get_reporting_chain chain outcome → { rules } or { matches }. */
export function orgChartRules(out) {
  const searchText = 'On the Org Chart (active Employee whose login holds the Employee role)';
  const deptText = 'Placed in an org-chart department';
  const section = sectionStatus(out);
  if (section.status !== 'ok') {
    const why = sectionEvidence(section, 'the org chart');
    return { rules: [rule(searchText, SOURCES.chartSearch, null, why), rule(deptText, SOURCES.chartDepartment, null, why)] };
  }
  const r = out.result;
  if (r.ambiguous) return { matches: { ambiguous: r.ambiguous, matches: (r.matches || []).slice(0, 10) } };
  if (r.notFound) {
    return {
      rules: [
        rule(searchText, SOURCES.chartSearch, false, r.note ?? null),
        rule(deptText, SOURCES.chartDepartment, null, 'Not on the chart at all.'),
      ],
    };
  }
  return {
    rules: [
      rule(searchText, SOURCES.chartSearch, true, `Found as ${r.person ?? 'this person'}.`),
      rule(deptText, SOURCES.chartDepartment, !!r.onChart,
        r.onChart ? { chain: (r.chain || []).slice(0, SECTION_ROWS).map((c) => `${c.level}: ${c.unit}`) } : r.chainNote ?? null),
    ],
  };
}

const PREFIX = Object.freeze({
  why_unavailable: 'Unavailable because',
  cannot_join_project: 'Cannot join because',
  cannot_move_to_onboarding: 'Blocked from Onboarding',
  not_in_employee_list: 'Not on the Employees page because',
  not_in_org_tree: 'Not on the org chart because',
  cannot_see_record: 'You cannot see',
});
const ALL_MET = Object.freeze({
  why_unavailable: 'No availability rule applies to them.',
  cannot_join_project: 'The project-limit rule allows them to join.',
  cannot_move_to_onboarding: 'Nothing blocks the move to Onboarding.',
  not_in_employee_list: 'Every Employees-page condition is met — search by exact name or employee id.',
  not_in_org_tree: 'They are on the org chart in a department.',
  cannot_see_record: 'You can see every checked record for this person.',
});

/** One line from the rules alone — viewer-only rules never count as a reason the person is blocked. */
export function conclude(question, rules) {
  const own = rules.filter((r) => !r.viewer);
  const failed = own.filter((r) => r.met === false);
  const unknown = own.filter((r) => r.met === null);
  if (failed.length) {
    const bypass = rules.find((r) => r.viewer && r.met === true);
    return `${PREFIX[question]}: ${failed.map((r) => r.rule).join('; ')}.${bypass ? ' You can bypass the pre-boarding gate.' : ''}`;
  }
  if (unknown.length) return `No checked rule blocks this; could not check: ${unknown.map((r) => r.rule).join('; ')}.`;
  return ALL_MET[question];
}
