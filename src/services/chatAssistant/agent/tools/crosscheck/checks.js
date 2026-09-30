import { overdueTaskClause } from '../../../taskAccess.js';
import { CLOSED_APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';
import { lastStatusChangeAt, unchangedSinceFilter } from '../../../../applicationStatusHistory.js';
import { REFERRAL_LEADS_ACCESS, isSelfReference, resolveLeadPerson } from '../hiring/common.js';
import { documentCounts } from '../hiring/placementDetail.js';
import {
  OBJECT_ID_RE, QUERY_MAX_MS, idOf, allowed, okSet, restrictedSet, guardSet, composedFailure,
  todayIst, istDayOf, istBounds, nextWeek, businessDaysBack, holidayDays, addDaysToDateStr,
} from './common.js';
import { employeesToUsers, mapSet, NAMES_BY_KIND } from './identity.js';
import {
  allocationSet, activeProjectSet, taskAssigneeSet, openTaskClause, trainingSet, filterSet, placementSet,
  offerSet, interviewSet, meetingParticipantSet, leaveSet, absentSet, chartSet, paperworkCompleteSet,
  applicationSet,
} from './sets.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const validIds = (ids) => [...ids].map(String).filter((id) => OBJECT_ID_RE.test(id));
const today = (e) => todayIst(e.deps.now());
const completed = (courses) => courses.filter((c) => c.status === 'Completed');
const titles = (courses) => courses.slice(0, 3).map((c) => c.course).filter(Boolean);
const ascBy = (field) => (a) => (x, y) => String(a.info.get(x)?.[field] ?? '9999').localeCompare(String(a.info.get(y)?.[field] ?? '9999'));

async function jobTitles(jobIds, deps) {
  const ids = validIds(new Set(jobIds.filter(Boolean)));
  if (!ids.length) return new Map();
  const jobs = await deps.Job.find({ _id: { $in: ids } }).select('title').lean();
  return new Map(jobs.map((j) => [idOf(j), j.title ?? null]));
}

const PLACEMENT_ACTIVE = ['Pending', 'Onboarding'];
const JOINED = { status: 'Joined' };
const OVERDUE_NOTE = 'Overdue as on the Tasks page: due before today (UTC day) and not completed.';

/**
 * Named checks, one per BRD Y question. run(args, e) returns a plan:
 *   { definition, op: 'minus'|'intersect'|'only', a, b?, row(id, aInfo, bInfo, extra, sets), order?, enrich?, notes?, extra? }
 * or { result } for an answer that needs no set logic (a composed Wave 1 tool, not-found name, empty input).
 */
export const CHECKS = {
  joining_next_week_preboarding_incomplete: {
    summary: 'joining next week (Mon–Sun IST) whose pre-boarding is not Completed',
    async run(args, e) {
      const week = nextWeek(today(e));
      const { from, to } = istBounds(week.from, week.to);
      const joining = { joiningDate: { $gte: from, $lte: to }, status: { $in: PLACEMENT_ACTIVE } };
      const [a, b] = await Promise.all([
        guardSet('Placements joining next week', () => placementSet(e, { clause: joining, label: 'Placements joining next week' })),
        guardSet('Pre-boarding completed', () => placementSet(e, {
          clause: { ...joining, preBoardingStatus: 'Completed' }, label: 'Pre-boarding completed',
        })),
      ]);
      return {
        definition: `Pending / Onboarding placements joining ${week.from} to ${week.to} (next Monday–Sunday, IST) ` +
          'minus those whose pre-boarding status is Completed.',
        op: 'minus', a, b, order: ascBy('joiningDate'), extra: { window: week },
        row: (id, ai) => ({ joiningDate: ai.joiningDate, placementStatus: ai.placementStatus, preBoardingStatus: ai.preBoardingStatus }),
      };
    },
  },

  onboarded_no_course: {
    summary: 'joined but have no training course assigned',
    async run(args, e) {
      const [placed, b] = await Promise.all([
        guardSet('Joined placements', () => placementSet(e, { clause: JOINED, label: 'Joined placements' })),
        guardSet('Training evaluation', () => trainingSet(e)),
      ]);
      const a = placed.status === 'ok' ? mapSet(placed, await employeesToUsers([...placed.ids], e.deps), 'user') : placed;
      return {
        definition: 'People whose placement is Joined (profile → login via Employee.owner) minus people with at ' +
          'least one course on the Training → Evaluation page.',
        op: 'minus', a, b,
        row: (id, ai) => ({ joinedOn: ai.joinedAt ?? ai.joiningDate }),
      };
    },
  },

  trained_no_project: {
    summary: 'completed at least one course but are on no active project',
    async run(args, e) {
      const a = filterSet(await guardSet('Training evaluation', () => trainingSet(e)),
        (v) => completed(v.courses).length > 0, 'Completed at least one course');
      const b = a.status === 'ok' ? await guardSet('Projects', () => activeProjectSet(e, a.ids, { label: 'On an active project' })) : null;
      return {
        definition: 'People who completed at least one course (Training → Evaluation) minus people listed on an ' +
          'active project (In progress / On hold).',
        op: 'minus', a, b,
        row: (id, ai) => ({ coursesCompleted: completed(ai.courses).length, courses: titles(completed(ai.courses)) }),
      };
    },
  },

  on_project_no_active_tasks: {
    summary: 'on an active project but with no open task',
    async run(args, e) {
      const a = await guardSet('Projects', () => allocationSet(e, { minProjects: 1, label: 'On an active project' }));
      const b = a.status === 'ok'
        ? await guardSet('Tasks', () => taskAssigneeSet(e, { clause: openTaskClause(), within: a.ids, label: 'Open tasks' }))
        : null;
      return {
        definition: 'Current employees on at least one active project minus people assigned an open task ' +
          '(new, todo, on_going, in_review).',
        op: 'minus', a, b,
        row: (id, ai) => ({ activeProjects: ai.activeProjects, designation: ai.designation }),
      };
    },
  },

  two_projects_overdue_tasks: {
    summary: 'on two or more active projects and with overdue tasks',
    async run(args, e) {
      const a = await guardSet('Projects', () => allocationSet(e, { minProjects: 2, label: 'On 2+ active projects' }));
      const b = a.status === 'ok'
        ? await guardSet('Tasks', () => taskAssigneeSet(e, { clause: overdueTaskClause(e.deps.now()), within: a.ids, label: 'Overdue tasks' }))
        : null;
      return {
        definition: 'Current employees on 2 or more active projects (the staffing limit) who are also assigned an overdue task.',
        op: 'intersect', a, b, notes: [OVERDUE_NOTE],
        row: (id, ai, bi) => ({ activeProjects: ai.activeProjects, overdueTasks: bi.tasks, examples: bi.titles }),
      };
    },
  },

  absent_today_tasks_due_today: {
    summary: 'absent today with tasks due today',
    async run(args, e) {
      const day = today(e);
      const a = await guardSet('Attendance', () => absentSet(e, { day, label: 'Absent today' }));
      const { from, to } = istBounds(day);
      const b = a.status === 'ok' ? await guardSet('Tasks', () => taskAssigneeSet(e, {
        clause: { dueDate: { $gte: from, $lte: to }, status: { $ne: 'completed' } }, within: a.ids, label: 'Tasks due today',
      })) : null;
      return {
        definition: `Employees marked Absent on ${day} (no punch-in; not on leave, holiday or week-off) who have an ` +
          'unfinished task due that day (IST).',
        op: 'intersect', a, b,
        row: (id, ai, bi) => ({ attendance: ai.attendance, tasksDueToday: bi.tasks, examples: bi.titles }),
      };
    },
  },

  on_leave_tomorrow_with_interview_or_meeting: {
    summary: 'on approved leave tomorrow who are in an interview or meeting tomorrow',
    async run(args, e) {
      const day = addDaysToDateStr(today(e), 1);
      const [a, b] = await Promise.all([
        guardSet('Approved leave', () => leaveSet(e, { day, label: 'Approved leave tomorrow' })),
        guardSet('Interviews and meetings', () => meetingParticipantSet(e, { day, label: 'Interviews and meetings tomorrow' })),
      ]);
      return {
        definition: `People with approved leave on ${day} who are also on a non-cancelled interview panel or ` +
          'internal meeting (organiser, host or invitee) that day.',
        op: 'intersect', a, b,
        row: (id, ai, bi) => ({ leaveType: ai.leaveType, meetings: bi.meetings, examples: bi.titles }),
      };
    },
  },

  not_punched_in_with_meeting_today: {
    summary: 'not punched in today who have an interview or meeting today',
    async run(args, e) {
      const day = today(e);
      const [a, b] = await Promise.all([
        guardSet('Attendance', () => absentSet(e, { day, label: 'Not punched in today' })),
        guardSet('Interviews and meetings', () => meetingParticipantSet(e, { day, label: 'Interviews and meetings today' })),
      ]);
      return {
        definition: `Employees with no punch-in on ${day} (Absent on the attendance summary) who are on a ` +
          'non-cancelled interview panel or internal meeting that day.',
        op: 'intersect', a, b,
        row: (id, ai, bi) => ({ meetings: bi.meetings, examples: bi.titles }),
      };
    },
  },

  passed_interview_no_offer: {
    summary: 'passed an interview (result selected) but have no offer for that application',
    async run(args, e) {
      const a = await guardSet('Interviews', () => interviewSet(e, {
        clause: { interviewResult: 'selected', status: { $ne: 'cancelled' } }, key: 'application', label: 'Interviews passed',
      }));
      const b = a.status === 'ok' ? await guardSet('Offers', () => offerSet(e, {
        clause: { jobApplication: { $in: validIds(a.ids) } }, key: 'application', label: 'Offers',
      })) : null;
      return {
        definition: 'Applications with a non-cancelled interview whose result is selected, minus applications that ' +
          'have an offer in any status. Interviews without an application link are counted as unmapped.',
        op: 'minus', a, b, order: (s) => (x, y) => String(s.info.get(y)?.interviewOn).localeCompare(String(s.info.get(x)?.interviewOn)),
        row: (id, ai) => ({ interviewOn: ai.interviewOn, jobPosition: ai.jobPosition }),
      };
    },
  },

  accepted_offer_documents_incomplete: {
    summary: 'accepted an offer but whose paperwork is incomplete',
    async run(args, e) {
      const a = await guardSet('Accepted offers', () => offerSet(e, { clause: { status: 'Accepted' }, key: 'employee', label: 'Accepted offers' }));
      const b = a.status === 'ok' ? await guardSet('Employee documents', () => paperworkCompleteSet(e, a.ids, { label: 'Paperwork complete' })) : null;
      return {
        definition: 'Candidates with an Accepted offer minus those whose paperwork is complete (at least one document, ' +
          'none awaiting review or rejected, no open document request).',
        op: 'minus', a, b,
        async enrich(ids) {
          const rows = await e.deps.Employee.find({ _id: { $in: validIds(ids) } })
            .select('documents.status documentRequests.status').lean();
          return new Map(rows.map((emp) => [idOf(emp), { documents: documentCounts(emp) }]));
        },
        row: (id, ai, bi, x) => ({ acceptedOn: ai.acceptedAt, joiningDate: ai.joiningDate, documents: x?.documents ?? null }),
      };
    },
  },

  bgv_done_not_onboarding: {
    summary: 'background verification done but not moved to onboarding',
    async run(args, e) {
      const bgvDone = { 'backgroundVerification.status': { $in: ['Completed', 'Verified'] }, status: { $ne: 'Cancelled' } };
      const [a, b] = await Promise.all([
        guardSet('BGV completed', () => placementSet(e, { clause: bgvDone, label: 'BGV completed' })),
        guardSet('In onboarding', () => placementSet(e, {
          clause: { ...bgvDone, $or: [{ status: { $in: ['Onboarding', 'Joined'] } }, { enteredOnboardingAt: { $ne: null } }] },
          label: 'In onboarding',
        })),
      ]);
      return {
        definition: 'Placements (not cancelled) whose background verification is Completed / Verified minus those ' +
          'that entered onboarding (status Onboarding / Joined, or moved to the onboarding queue).',
        op: 'minus', a, b,
        row: (id, ai) => ({ bgvStatus: ai.bgvStatus, bgvCompletedOn: ai.bgvCompletedAt, placementStatus: ai.placementStatus }),
      };
    },
  },

  onboarded_not_in_org_tree: {
    summary: 'joined but not placed in an org-chart department',
    async run(args, e) {
      const [a, b] = await Promise.all([
        guardSet('Joined placements', () => placementSet(e, { clause: JOINED, label: 'Joined placements' })),
        guardSet('Org chart', () => chartSet(e, { label: 'Placed on the org chart' })),
      ]);
      return {
        definition: 'People whose placement is Joined minus employees placed in an org-chart department node.',
        op: 'minus', a, b,
        row: (id, ai, bi, x, sets) => ({
          joinedOn: ai.joinedAt ?? ai.joiningDate,
          orgChart: sets.b.unassigned?.has(id) ? 'on the chart, in no department' : 'not on the org chart',
        }),
      };
    },
  },

  no_reporting_manager: {
    summary: 'active employees with no reporting manager set',
    async run(args, e) {
      const definition = 'Active employees on the Org Chart minus those with Employee.reportingManager set ' +
        '(get_reporting_chain mode no_reporting_manager).';
      const res = await e.deps.runTool('get_reporting_chain', { mode: 'no_reporting_manager', limit: args.limit }, e.ctx, { timeoutMs: 10000 });
      if (res.status !== 'ok' || res.result?.error) return { definition, a: composedFailure('Org chart', res) };
      const r = res.result;
      return {
        result: {
          status: 'ok', definition, total: r.total, atLeast: false,
          sets: [{ section: 'Active employees on the org chart', status: 'ok', total: r.totalActiveEmployees ?? null }],
          rows: r.records || [], notes: r.note ? [r.note] : [], composedFrom: 'get_reporting_chain',
        },
      };
    },
  },

  no_project_all_training_complete: {
    summary: 'on no active project whose assigned training is all completed',
    async run(args, e) {
      const [a, t] = await Promise.all([
        guardSet('Projects', () => allocationSet(e, { maxProjects: 0, label: 'On no active project' })),
        guardSet('Training evaluation', () => trainingSet(e)),
      ]);
      const b = filterSet(t, (v) => v.courses.length > 0 && completed(v.courses).length === v.courses.length,
        'All assigned courses completed');
      return {
        definition: 'Current employees on no active project who have at least one assigned course and have ' +
          'completed every one (training has no due date in DharwinOne).',
        op: 'intersect', a, b,
        row: (id, ai, bi) => ({ designation: ai.designation, coursesCompleted: bi.courses.length, courses: titles(bi.courses) }),
      };
    },
  },

  available_with_training_score: {
    summary: 'on no active project with a quiz score at or above minScore (optionally in a skill\'s course)',
    async run(args, e) {
      const minScore = args.minScore ?? 70;
      const skill = args.skill ? lc(args.skill) : null;
      const [a, t] = await Promise.all([
        guardSet('Projects', () => allocationSet(e, { maxProjects: 0, label: 'On no active project' })),
        guardSet('Training evaluation', () => trainingSet(e)),
      ]);
      const b = filterSet(t, (v) => {
        const hits = v.courses.filter((c) => c.quizScore != null && c.quizScore >= minScore && (!skill || lc(c.course).includes(skill)));
        if (!hits.length) return null;
        const best = hits.reduce((x, y) => (y.quizScore > x.quizScore ? y : x));
        return { bestScore: best.quizScore, course: best.course, matchingCourses: hits.length };
      }, `Quiz score ≥ ${minScore}${skill ? ` in a course matching "${args.skill}"` : ''}`);
      return {
        definition: `Current employees on no active project with a graded quiz score of at least ${minScore}%` +
          `${skill ? ` in a course whose name contains "${args.skill}"` : ' in any course'} (Training → Evaluation).`,
        op: 'intersect', a, b, extra: { minScore, ...(args.skill ? { skill: args.skill } : {}) },
        order: (sa, sb) => (x, y) => (sb.info.get(y)?.bestScore ?? 0) - (sb.info.get(x)?.bestScore ?? 0),
        row: (id, ai, bi) => ({ designation: ai.designation, course: bi.course, quizScore: bi.bestScore }),
      };
    },
  },

  bench_matches_recent_jobs: {
    summary: 'unallocated employees who match the newest jobs (match_candidates_to_job, pool employees)',
    async run(args, e) {
      const jobCount = args.jobCount ?? 5;
      const definition = `Employees ranked by match_candidates_to_job (pool employees, top 25 per job) for the ${jobCount} ` +
        `newest active job(s)${args.jobKeyword ? ` matching "${args.jobKeyword}"` : ''}, intersected with unallocated ` +
        'employees (no active project and no open task).';
      const jobsRes = await e.deps.runTool('list_jobs', {
        filters: args.jobKeyword ? { search: args.jobKeyword } : {}, limit: jobCount,
      }, e.ctx, { timeoutMs: 6000 });
      if (jobsRes.status !== 'ok' || jobsRes.result?.error) return { definition, a: composedFailure('Jobs', jobsRes) };
      const jobs = (jobsRes.result.jobs || []).map((j) => ({ jobId: j.jobId, title: j.title ?? null }));
      if (!jobs.length) {
        return { result: { status: 'ok', definition, total: 0, atLeast: false, jobs, rows: [], notes: ['No active job matched.'] } };
      }
      const [matches, avail] = await Promise.all([
        Promise.all(jobs.map((j) => e.deps.runTool('match_candidates_to_job', { jobId: j.jobId, pool: 'employees', limit: 25 }, e.ctx, { timeoutMs: 8000 }))),
        guardSet('Projects', () => allocationSet(e, { maxProjects: 0, label: 'On no active project' })),
      ]);
      const notes = [];
      const failed = matches.filter((m) => m.status !== 'ok' || m.result?.error);
      let a;
      if (failed.length === matches.length) a = composedFailure('Profile matching', failed[0]);
      else {
        if (failed.length) notes.push(`Matching failed for ${failed.length} of ${jobs.length} job(s); those jobs are left out.`);
        const info = new Map();
        matches.forEach((m, i) => {
          if (m.status !== 'ok' || m.result?.error) return;
          for (const c of m.result.candidates || []) {
            if (!c.userId) continue;
            const cur = info.get(c.userId);
            if (!cur || c.matchPct > cur.matchPct) info.set(c.userId, { matchPct: c.matchPct, job: jobs[i].title, jobsMatched: (cur?.jobsMatched ?? 0) + 1 });
            else cur.jobsMatched += 1;
          }
        });
        a = okSet('Matched to recent jobs', 'user', info);
      }
      let b = avail;
      if (avail.status === 'ok') {
        const busy = await guardSet('Tasks', () => taskAssigneeSet(e, { clause: openTaskClause(), within: avail.ids, label: 'Open tasks' }));
        if (busy.status === 'ok') b = filterSet(avail, (v, id) => !busy.ids.has(id), 'Unallocated (no active project, no open task)');
        else notes.push('Open-task counts are not available to you (tasks.read), so "unallocated" here means no active project only.');
      }
      return {
        definition, op: 'intersect', a, b, notes, extra: { jobs },
        order: (sa) => (x, y) => (sa.info.get(y)?.matchPct ?? 0) - (sa.info.get(x)?.matchPct ?? 0),
        row: (id, ai, bi) => ({ bestJob: ai.job, matchPct: ai.matchPct, jobsMatched: ai.jobsMatched, designation: bi.designation ?? null }),
      };
    },
  },

  referred_screened_never_interviewed: {
    summary: 'referral leads at Screening / Shortlisted who never had an interview (optionally one sales agent\'s)',
    async run(args, e) {
      const { user, deps } = e;
      const definition = 'Referral-lead candidates with an application at Screening or Shortlisted minus candidates ' +
        'with any non-cancelled interview.';
      if (!(await allowed(REFERRAL_LEADS_ACCESS, user, deps))) return { definition, a: restrictedSet('Referral leads') };
      const selfId = String(user.id ?? user._id);
      const canAll = await deps.canSeeAllReferralLeads(user);
      let agent = null;
      if (args.salesAgent) {
        if (isSelfReference(args.salesAgent, user)) agent = { id: selfId, name: user.name ?? null };
        else if (!canAll) return { result: { status: 'ok', error: 'You can only see your own referral leads, so another sales agent cannot be named.' } };
        else {
          const r = await resolveLeadPerson('salesAgent', args.salesAgent, user, deps);
          if (r.notFound) return { result: { status: 'ok', notFound: 'salesAgent', searchedFor: args.salesAgent } };
          if (r.matches) return { result: { status: 'ok', ambiguous: 'salesAgent', matches: r.matches } };
          agent = r;
        }
      }
      const apps = await guardSet('Applications', () => applicationSet(e, {
        clause: { status: { $in: ['Screening', 'Shortlisted'] } }, key: 'employee', label: 'Applications at Screening / Shortlisted',
      }));
      if (apps.status !== 'ok') return { definition, a: apps };
      const leadIds = new Set();
      const ids = validIds(apps.ids);
      if (ids.length) {
        const leads = await deps.Employee.find({
          _id: { $in: ids },
          referredByUserId: { $ne: null },
          ...(agent ? { currentSalesAgentUserId: agent.id } : {}),
          ...(canAll ? {} : { $or: [{ referredByUserId: selfId }, { currentSalesAgentUserId: selfId }] }),
        }).select('_id').maxTimeMS(QUERY_MAX_MS).lean();
        for (const l of leads) leadIds.add(idOf(l));
      }
      const a = filterSet(apps, (v, id) => leadIds.has(id), 'Referral leads at Screening / Shortlisted');
      const b = await guardSet('Interviews', () => interviewSet(e, {
        clause: { 'candidate.id': { $in: [...a.ids] }, status: { $ne: 'cancelled' } }, key: 'employee', label: 'Interviews (any)',
      }));
      return {
        definition, op: 'minus', a, b,
        notes: canAll ? [] : ['Only referral leads you referred or are the sales agent for.'],
        extra: agent ? { salesAgent: agent.name } : {},
        enrich: async (shown) => {
          const t = await jobTitles(shown.map((id) => a.info.get(id)?.job), deps);
          return new Map(shown.map((id) => [id, { job: t.get(a.info.get(id)?.job) ?? null }]));
        },
        row: (id, ai, bi, x) => ({ applicationStatus: ai.status, job: x?.job ?? null }),
      };
    },
  },

  applications_unchanged: {
    summary: 'open applications with no status change for N business days',
    async run(args, e) {
      const businessDays = args.businessDays ?? 5;
      const day = today(e);
      const hol = await e.deps.runTool('list_holidays', {
        scope: 'company', window: { from: addDaysToDateStr(day, -(businessDays * 2 + 21)), to: day }, limit: 50,
      }, e.ctx, { timeoutMs: 5000 });
      const holidaysOk = hol.status === 'ok' && !hol.result?.error;
      const holidays = holidaysOk ? holidayDays(hol.result.holidays) : new Set();
      const firstDay = businessDaysBack(day, businessDays, holidays);
      const cutoff = new Date(istBounds(firstDay).from.getTime() - 1);
      const a = await guardSet('Applications', () => applicationSet(e, {
        clause: { $and: [{ status: { $nin: [...CLOSED_APPLICATION_STATUSES] } }, unchangedSinceFilter(cutoff)] },
        sort: { updatedAt: 1 }, label: 'Open applications unchanged',
      }));
      const basis = { statusChangedAt: 0, updatedAt: 0 };
      const last = new Map();
      if (a.status === 'ok') {
        for (const [id, v] of a.info) {
          const lc2 = lastStatusChangeAt(v);
          basis[lc2.basis] += 1;
          last.set(id, lc2);
        }
      }
      return {
        definition: `Open applications (not ${CLOSED_APPLICATION_STATUSES.join(' / ')}) with no status change on any ` +
          `of the last ${businessDays} business days (Mon–Fri IST${holidaysOk ? ', company holidays skipped' : ''}) or today: ` +
          `last change before ${firstDay}. Uses statusChangedAt when recorded, else updatedAt (any edit).`,
        op: 'only', a,
        notes: holidaysOk ? [] : ['Company holidays were not skipped (seeing them needs students.read).'],
        extra: { businessDays, noChangeSince: firstDay, basis, holidaysSkipped: holidaysOk ? holidays.size : null },
        order: () => (x, y) => new Date(last.get(x)?.at ?? 0) - new Date(last.get(y)?.at ?? 0),
        enrich: async (shown) => {
          const t = await jobTitles(shown.map((id) => a.info.get(id)?.job), e.deps);
          return new Map(shown.map((id) => [id, { job: t.get(a.info.get(id)?.job) ?? null }]));
        },
        row: (id, ai, bi, x) => ({
          status: ai.status, job: x?.job ?? null,
          lastChange: istDayOf(last.get(id)?.at), lastChangeBasis: last.get(id)?.basis ?? null,
        }),
      };
    },
  },
};

export const CHECK_NAMES = Object.keys(CHECKS);

// ─── Runner ─────────────────────────────────────────────────────────────────

const setSummary = (s) => ({
  section: s.label, status: s.status,
  ...(s.status === 'ok' ? { total: s.total, ...(s.truncated ? { truncated: true } : {}), ...(s.unmapped ? { unmapped: s.unmapped } : {}) } : {}),
  ...(s.status !== 'ok' && s.status !== 'restricted' && s.reason ? { reason: s.reason } : {}),
});

/** A restricted or failed set fails the whole check; a restricted section is named, never described. */
function failure(query, definition, sets) {
  const failed = sets.filter((s) => s.status !== 'ok');
  const restricted = failed.filter((s) => s.status === 'restricted');
  const status = restricted.length ? 'restricted' : failed[0].status;
  return {
    query, status, definition,
    sections: failed.map(setSummary),
    note: restricted.length
      ? `You do not have access to: ${restricted.map((s) => s.label).join(', ')}. No partial answer is given.`
      : `Could not complete: ${failed.map((s) => `${s.label} (${s.status})`).join(', ')}.`,
  };
}

export async function runCheck(query, args, e, limit) {
  const plan = await CHECKS[query].run({ ...args, limit }, e);
  if (plan.result) return { query, ...plan.result };
  const sets = [plan.a, plan.b].filter(Boolean);
  if (sets.some((s) => s.status !== 'ok')) return failure(query, plan.definition, sets);

  const { a, b, op } = plan;
  let ids = [...a.ids];
  if (op === 'minus') ids = ids.filter((id) => !b.ids.has(id));
  if (op === 'intersect') ids = ids.filter((id) => b.ids.has(id));
  if (plan.order) ids.sort(plan.order(a, b));

  const shown = ids.slice(0, limit);
  const [names, extra] = await Promise.all([
    NAMES_BY_KIND[a.kind](shown, e.deps),
    plan.enrich ? plan.enrich(shown) : new Map(),
  ]);
  const rows = shown.map((id) => ({
    name: names.get(id)?.name ?? null,
    ...(names.get(id)?.employeeId ? { employeeId: names.get(id).employeeId } : {}),
    ...(names.get(id)?.job ? { job: names.get(id).job } : {}),
    ...(a.kind === 'user' && names.get(id) && !names.get(id).employeeProfile ? { employeeProfile: false } : {}),
    ...plan.row(id, a.info.get(id), b?.info.get(id), extra.get(id), { a, b }),
  }));

  const atLeast = a.truncated || (op === 'intersect' && !!b?.truncated);
  const notes = [...(plan.notes || [])];
  for (const s of sets) {
    if (s.partialScope) notes.push(`${s.label}: ${s.partialScope}`);
    for (const n of s.notes || []) notes.push(`${s.label}: ${n}`);
    if (s.unmapped) notes.push(`${s.label}: ${s.unmapped} record(s) could not be linked to a person and are not counted.`);
    if (s.truncated) notes.push(`${s.label}: more than ${s.total} records — only the first ${s.total} were compared.`);
  }
  if (op === 'minus' && b?.truncated) notes.push('Some people listed may belong to the excluded group (it hit the size cap).');
  const seen = new Map();
  for (const r of rows) if (r.name) seen.set(lc(r.name), (seen.get(lc(r.name)) ?? 0) + 1);
  if ([...seen.values()].some((n) => n > 1)) notes.push('Some people share a name; employeeId tells them apart.');
  if (rows.some((r) => r.name == null)) notes.push('A null name means the name is not captured in DharwinOne.');

  return {
    query, status: 'ok', definition: plan.definition,
    total: ids.length, atLeast, ...(op === 'minus' && b?.truncated ? { approximate: true } : {}),
    sets: sets.map(setSummary),
    rows,
    notes,
    ...(plan.extra || {}),
  };
}
