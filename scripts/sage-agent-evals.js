#!/usr/bin/env node
// Tool-pick eval runner for Sage's agent loop (architecture.md §6).
//
// Uses the REAL tool registry schemas + REAL runAgent + REAL llm.step against
// the live OpenAI model, but replaces tool EXECUTION with fake, canned
// results — no MongoDB access anywhere in this script. Scores each case's
// recorded tool calls against cases.json's `expect`, then reports accuracy
// and latency. Report-only by default (--min 0 means "never fail the run");
// pass --min <pct> to exit 1 when accuracy drops below it.
//
// Cases come from __evals__/cases.json plus every __evals__/*.cases.json.
// `find_tools` (lazy tool loading) is not scored, like `handoff`.
//
// Usage:
//   node scripts/sage-agent-evals.js
//   node scripts/sage-agent-evals.js --case count-plain-react
//   node scripts/sage-agent-evals.js --file F.core.cases.json   (or --file F.core)
//   node scripts/sage-agent-evals.js --eager                    (every permitted tool up front, no find_tools)
//   node scripts/sage-agent-evals.js --min 80
//   node scripts/sage-agent-evals.js --check                    (offline: validate case files + canned results, no OpenAI)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

import config from '../src/config/config.js';
import { runAgent } from '../src/services/chatAssistant/agent/runAgent.js';
import { getAgentTools as realGetAgentTools } from '../src/services/chatAssistant/agent/toolRegistry.js';
import { step as realLlmStep } from '../src/services/chatAssistant/agent/llm.js';
import toolDomains from '../src/services/chatAssistant/agent/tools/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVALS_DIR = path.resolve(__dirname, '../src/services/chatAssistant/agent/__evals__');
const FIND_TOOLS = 'find_tools';
const UNSCORED_TOOLS = new Set(['handoff', FIND_TOOLS]);

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { caseId: null, file: null, eager: false, min: 0, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') out.caseId = argv[++i];
    else if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--eager') out.eager = true;
    else if (argv[i] === '--min') out.min = Number(argv[++i]);
    else if (argv[i] === '--check') out.check = true;
  }
  return out;
}

/** cases.json first, then every *.cases.json by name; `file` keeps just that one. */
function loadCaseFiles(file) {
  const names = ['cases.json', ...fs.readdirSync(EVALS_DIR).filter((n) => n.endsWith('.cases.json')).sort()];
  const picked = file ? names.filter((n) => n === file || n === `${file}.cases.json`) : names;
  return picked.flatMap((name) =>
    JSON.parse(fs.readFileSync(path.join(EVALS_DIR, name), 'utf8')).map((c) => ({ ...c, file: name }))
  );
}

// ─── Arg matching: partial, case-insensitive on strings ────────────────────

function normalizeVal(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

/** True when every field of `expected` is present with an equal value in `actual` (deep, partial). */
function partialMatch(expected, actual) {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    const normActual = actual.map(normalizeVal);
    return expected.map(normalizeVal).every((e) => normActual.includes(e));
  }
  if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => partialMatch(v, actual[k]));
  }
  return normalizeVal(expected) === normalizeVal(actual);
}

// ─── Expectation scoring ────────────────────────────────────────────────────

const VALID_GROUP_BY = ['jobType', 'status', 'experienceLevel', 'company', 'city', 'country', 'industry', 'origin'];

const RULES = {
  // "jobs in each category" etc.: whatever the model answers with, it must not
  // hallucinate a groupBy value outside count_jobs' own enum. No call, or a
  // call with no groupBy, or a handoff all pass; an invented groupBy fails.
  no_invalid_groupby: (calls) =>
    !calls.some((c) => c.name === 'count_jobs' && c.args?.groupBy && !VALID_GROUP_BY.includes(c.args.groupBy)),
};

/**
 * Exact-name-set check PLUS a call-count ceiling: the total number of
 * non-handoff calls must not exceed `expected.length` (one call per expected
 * tool), unless `maxCalls` raises that ceiling for a case that legitimately
 * needs more than one call to the same tool (e.g. comparing two filters).
 * `new Set(names)` alone would dedupe repeat calls to an already-expected
 * tool and miss them entirely — this keeps that name-set check but also
 * counts.
 */
function toolCallsMatch(toolCalls, expected, maxCalls) {
  const names = toolCalls.map((c) => c.name);
  const distinctActual = [...new Set(names)].sort();
  const distinctExpected = [...expected].sort();
  const sameNames =
    distinctActual.length === distinctExpected.length && distinctActual.every((v, i) => v === distinctExpected[i]);
  if (!sameNames) return false;
  const ceiling = maxCalls ?? expected.length;
  return names.length <= ceiling;
}

const SEARCHABLE_JOB_TOOLS = ['count_jobs', 'list_jobs', 'rank_jobs_by_salary', 'get_job'];

/**
 * True if any job-tool call leaked a person's name into a job query — e.g. the
 * model searching jobs for "John" instead of handing off a people question.
 * Scans EVERY string value anywhere in the call's args, recursively (filters.search,
 * filters.company, filters.city, title, ...) rather than a fixed field list — the
 * reproduced leak used filters.company, not filters.search, so a fixed list would
 * have missed it on a parallel call that also called `handoff`.
 */
function containsSearchTerm(calls, term) {
  const needle = term.toLowerCase();
  const hasTerm = (value) => {
    if (typeof value === 'string') return value.toLowerCase().includes(needle);
    if (Array.isArray(value)) return value.some(hasTerm);
    if (value && typeof value === 'object') return Object.values(value).some(hasTerm);
    return false;
  };
  return calls.some((c) => SEARCHABLE_JOB_TOOLS.includes(c.name) && hasTerm(c.args));
}

/** @param {object} expect one case's `expect`, or one `anyOf` alternative */
function evaluateExpect(expect, ctx) {
  if (expect.anyOf) return expect.anyOf.some((alt) => evaluateExpect(alt, ctx));
  if (expect.rule) return RULES[expect.rule](ctx.calls);
  // `handoff: true` = the model must call `handoff` (in production Sage then sends its
  // fixed "can't answer that yet" reply) rather than guess with a tool or from memory.
  if (expect.handoff) {
    if (!ctx.handoffCalled) return false;
    if (expect.forbidSearchTerm && containsSearchTerm(ctx.calls, expect.forbidSearchTerm)) return false;
    return true;
  }

  // `answer: true` = Sage must reply itself (e.g. a definition), not hand off.
  if (expect.answer && ctx.handoffCalled) return false;

  const toolCalls = ctx.calls.filter((c) => !UNSCORED_TOOLS.has(c.name));
  if (expect.tools && !toolCallsMatch(toolCalls, expect.tools, expect.maxCalls)) return false;

  if (expect.args) {
    for (const [tool, spec] of Object.entries(expect.args)) {
      // A spec can be one partial-match object, or an array where EACH entry
      // must be satisfied by some call to that tool (e.g. two count_jobs
      // calls with different jobType filters).
      const specs = Array.isArray(spec) ? spec : [spec];
      const callsForTool = toolCalls.filter((c) => c.name === tool);
      if (!specs.every((s) => callsForTool.some((c) => partialMatch(s, c.args)))) return false;
    }
  }
  return true;
}

// ─── Fake user (read permissions for every domain, no DB) ────────────────────
// Only `access.anyOf` gates read these (execute is faked), but the in-execute permissions
// (call AI/transcripts, interview transcript/summary, activity logs, offers) are granted too so
// the set matches a real HR admin. `--check` fails if an expected tool is hidden from this user.

const FAKE_USER = Object.freeze({
  id: 'eval-user-0000000000000001',
  name: 'Eval User',
  authContext: {
    permissions: new Set([
       'jobs.read', 'users.read', 'roles.read', 'employees.read', 'candidates.read',
       'interviews.read', 'students.read', 'chart.read', 'attendance.assign', 'students.manage',
       'projects.read', 'teams.read', 'tasks.read',
       'meetings.read', 'emails.read', 'chats.read', 'evaluation.read', 'positions.read', 'structure.read',
       'calls.view', 'call-recording.view', 'call-transcripts.read', 'call-ai.read', 'users.impersonate',
       'interviews.transcript.read', 'interviews.summary.read', 'activityLogs.read',
       'offers.read', 'pre-boarding.read', 'onboarding.read', 'dashboard.view',
       // list_email_activity's gate (EMAIL_ACTIVITY_ACCESS): the Activity Logs delete tier.
       'activity.delete',
       // The actions domain's write gates (drafts only; execute is faked, so nothing is stored or sent).
       'interviews.manage', 'pre-boarding.create', 'modules.manage', 'projects.manage', 'tasks.manage',
    ]),
  },
});

function jobRow(i, overrides = {}) {
  return {
    jobId: `eval-job-${i}`,
    jobUrl: `/jobs/eval-job-${i}`,
    title: `Eval Job ${i}`,
    organisation: { name: 'Acme Corp' },
    jobType: 'Full-time',
    location: 'Remote',
    status: 'Active',
    experienceLevel: 'Mid Level',
    salaryRange: null,
    skillTags: [],
    vacancies: 1,
    ...overrides,
  };
}

function evalUserRow(i, overrides = {}) {
  return {
    id: `eval-user-${i}`,
    name: `Eval Person ${i}`,
    email: `eval.person${i}@example.com`,
    roles: ['Recruiter'],
    status: 'active',
    lastLoginAt: new Date().toISOString(),
    ...overrides,
  };
}

function evalRoleRow(name, overrides = {}) {
  return { id: `eval-role-${name}`, name, aliases: [], status: 'active', userCount: 3, ...overrides };
}

// A tool with no canned result below; `--check` fails on any registered tool that returns it.
const NO_CANNED_RESULT = Object.freeze({ handoff: true });

/** What registry.execute hands the model for a write tool (sageActions createDraft), minus the stored row. */
function draftResult(title, lines, targets, confirmLabel) {
  return {
    draft: true,
    key: '00000000-0000-4000-8000-000000000001',
    summary: { title, lines, targetCount: targets.length, targets, confirmLabel },
    expiresAt: '2026-09-30T12:15:00.000Z',
  };
}

const namesOf = (people, fallback) => (people?.length ? people : [fallback]);

/**
 * A plausible fake result per tool name. Shape matches what the real tool
 * returns closely enough for runAgent's ledger (`total`) to work; content is
 * otherwise inert — this eval measures tool PICKS, not rendering or numbers.
 */
function cannedResult(name, args) {
  switch (name) {
    case 'count_jobs': {
      if (args?.groupBy) {
        // origin's real groups are always internal/external; placeholder names there made the model
        // re-count each origin separately to find the numbers it asked for.
        const [first, second] = args.groupBy === 'origin' ? ['internal', 'external'] : ['alpha', 'beta'];
        return {
          total: 7,
          groupBy: args.groupBy,
          groups: [
            { value: first, count: 4 },
            { value: second, count: 3 },
          ],
          filtersApplied: args.filters ?? {},
        };
      }
      return { total: 7, filtersApplied: args?.filters ?? {} };
    }
    case 'list_jobs':
      return { total: 3, jobs: [jobRow(1), jobRow(2), jobRow(3)], filtersApplied: args?.filters ?? {} };
    case 'rank_jobs_by_salary':
      return {
        total: 5,
        direction: args?.direction ?? 'desc',
        jobs: [
          jobRow(1, { salaryRange: { min: 2000000, max: 2200000 } }),
          jobRow(2, { salaryRange: { min: 1800000, max: 2000000 } }),
        ],
      };
    case 'get_job':
      return { job: jobRow(1, {
        title: args?.title || 'Eval Job', jobDescription: 'Eval-only canned description.',
        createdBy: 'Asha Rao', recruiter: 'Vikram Shah', applicationDeadline: '2026-10-31',
        salaryRange: { min: 1200000, max: 1500000 }, project: null, workAuthorization: null,
      }) };
    case 'count_users': {
      // Real role names, so a "how many of them are employees/candidates" case can be answered from the
      // groups without the model going back for per-role counts.
      if (args?.groupBy === 'role') {
        return {
          total: 24,
          groupBy: 'role',
          groups: [
            { value: 'Employee', count: 15 },
            { value: 'Candidate', count: 6 },
            { value: 'Administrator', count: 3 },
          ],
          filtersApplied: args.filters ?? {},
        };
      }
      if (args?.groupBy) {
        return {
          total: 24,
          groupBy: args.groupBy,
          groups: [
            { value: 'alpha', count: 14 },
            { value: 'beta', count: 10 },
          ],
          filtersApplied: args.filters ?? {},
        };
      }
      return { total: 24, filtersApplied: args?.filters ?? {} };
    }
    case 'list_users': {
      // A row's lastLoginAt must agree with the inactivity filter, or the model re-queries to reconcile them.
      const f = args?.filters ?? {};
      const lastLoginAt = f.neverLoggedIn ? null : (f.inactiveDays ? '2026-08-01T09:00:00.000Z' : undefined);
      const row = (i) => evalUserRow(i, lastLoginAt === undefined ? {} : { lastLoginAt });
      return {
        total: 3,
        users: [row(1), row(2), row(3)],
        filtersApplied: args?.filters ?? {},
      };
    }
    case 'get_user':
      return {
        kind: 'unique',
        identity: { userId: 'eval-user-1', name: args?.name || 'Eval Person', email: 'eval.person@example.com' },
        roles: [{ name: 'Recruiter', slug: 'recruiter', aliases: [], status: 'active', permissions: [] }],
        profiles: {},
        availableSections: [],
      };
    case 'list_roles':
      if (args?.status === 'inactive') return { roles: [evalRoleRow('Legacy Intern', { status: 'inactive', userCount: 0 })] };
      return { roles: [evalRoleRow('Administrator'), evalRoleRow('Recruiter'), evalRoleRow('Sales Agent')] };
    case 'get_role':
      return {
        name: args?.name || 'Eval Role',
        slug: 'eval-role',
        aliases: [],
        status: 'active',
        permissions: ['users.read', 'jobs.read'],
      };
    case 'count_employees':
      if (args?.groupBy === 'employmentStatus') {
        return { total: 42, groupBy: args.groupBy, groups: [{ value: 'current', count: 38 }, { value: 'resigned', count: 4 }] };
      }
      return args?.groupBy
        ? { total: 42, groupBy: args.groupBy, groups: [{ value: 'Engineering', count: 30 }, { value: 'Sales', count: 12 }] }
        : { total: 42, filtersApplied: args?.filters ?? {} };
    case 'list_employees':
      return { total: 2, page: 1, hasNextPage: false, records: [
        { id: 'e1', name: 'Asha Rao', designation: 'React Developer', department: 'Engineering', employmentType: 'Full-time' },
        { id: 'e2', name: 'Vikram Shah', designation: 'Sales Lead', department: 'Sales', employmentType: 'Full-time' },
      ] };
    case 'count_candidates':
      return { total: 17, filtersApplied: args?.filters ?? {} };
    case 'list_candidates':
      return { total: 1, page: 1, hasNextPage: false, records: [{ id: 'c1', name: 'Ravi Kumar', designation: 'QA' }] };
    case 'count_applications':
      return { total: 3, baseTotal: 3, breakdown: { Applied: 2, Interview: 1 }, filtersApplied: args?.filters ?? {} };
    case 'list_applications':
      return { total: 2, records: [
        { id: 'a1', applicant: 'Ranveer Singh', job: 'React Developer', status: 'Applied' },
        { id: 'a2', applicant: 'Ranveer Singh', job: 'QA Engineer', status: 'Interview' },
      ] };
    case 'count_projects':
      return { total: 6, scope: 'all', filtersApplied: args?.filters ?? {} };
    case 'list_projects':
      return { total: 1, scope: 'all', records: [{ id: 'p1', name: 'Portal Revamp', status: 'Inprogress', priority: 'high', teams: ['Alpha'] }] };
    case 'list_teams':
      return { total: 2, records: [{ id: 't1', name: 'Alpha', memberCount: 4 }, { id: 't2', name: 'Beta', memberCount: 3 }] };
    case 'count_tasks':
      return { total: 12, scope: 'all', groupBy: args?.groupBy, groups: [{ value: 'in_review', count: 3 }], overdue: 2, blocked: 1, filtersApplied: args?.filters ?? {} };
    case 'list_tasks':
      return { total: 1, scope: 'mine', records: [{ id: 'k1', code: 'T-1', title: 'Fix login', status: 'todo', assignees: ['Eval Self'] }] };
    case 'get_workload':
      return { metric: args?.metric ?? 'most_tasks', rows: [{ name: 'Asha Rao', openCount: 9, totalCount: 14 }] };
    case 'get_my_profile':
      return {
        kind: 'unique',
        identity: { userId: 'eval-self', name: 'Eval Self', email: 'eval.self@example.com', roles: ['Employee'] },
        profiles: { employee: { fields: { employeeId: 'DBS001', designation: 'QA Engineer' }, visibleFields: ['employeeId', 'designation'] } },
        availableSections: [],
      };
    case 'match_candidates_to_job':
      return { job: args?.jobTitle || 'Eval Job', jobId: 'eval-job-1', pool: args?.pool || 'candidates', candidates: [
        { name: 'Ravi Kumar', skills: ['React', 'Node'], matchPct: 91, userId: 'c1' },
        { name: 'Meera Iyer', skills: ['React'], matchPct: 64, userId: 'c2' },
      ] };
    // Hiring counts: a status/result filter narrows `total` to that bucket, like the real tools — an
    // unfiltered-looking total next to a filtered call made the model re-count without the filter.
    case 'count_interviews': {
      const byStatus = { scheduled: 4, ended: 2, cancelled: 0 };
      const byResult = { pending: 4, selected: 1, rejected: 1 };
      const f = args?.filters ?? {};
      const total = f.status ? byStatus[f.status] : (f.result ? byResult[f.result] : 6);
      return { total, byStatus, byResult, filtersApplied: f };
    }
    case 'list_interviews':
      if (args?.filters?.resultMissing || args?.filters?.overlapping) {
        return { total: 2, page: 1, totalPages: 1, records: [
          { id: 'm1', candidate: 'Ravi Kumar', jobPosition: 'QA Engineer', interviewers: 'Asha Rao (recruiter)', scheduledAt: '2026-09-29T10:00:00.000Z', status: 'ended', result: 'pending' },
          { id: 'm2', candidate: 'Meera Iyer', jobPosition: 'React Developer', interviewers: 'Asha Rao (recruiter)', scheduledAt: '2026-09-29T10:30:00.000Z', status: 'ended', result: 'pending' },
        ], filtersApplied: args.filters };
      }
      return { total: 2, page: 1, totalPages: 1, records: [
        { id: 'm1', candidate: 'Ravi Kumar', jobPosition: 'QA Engineer', interviewers: 'Asha Rao (recruiter)', scheduledAt: '2026-09-29T10:00:00.000Z', status: 'scheduled', result: 'pending' },
        { id: 'm2', candidate: 'Meera Iyer', jobPosition: 'React Developer', interviewers: 'Asha Rao (recruiter)', scheduledAt: '2026-09-28T09:00:00.000Z', status: 'ended', result: 'selected' },
      ], filtersApplied: args?.filters ?? {} };
    case 'count_offers': {
      const byStatus = { Draft: 2, Sent: 3, 'Under Negotiation': 1, Accepted: 2, Rejected: 1 };
      const f = args?.filters ?? {};
      return { total: f.status ? byStatus[f.status] : 9, byStatus, filtersApplied: f };
    }
    case 'list_offers':
      if (args?.filters?.pendingOverDays) {
        return { total: 2, page: 1, totalPages: 1, compensationHidden: true, sentDateMissing: 0, records: [
          { id: 'o3', offerCode: 'OF-3', candidate: 'Ravi Kumar', job: 'QA Engineer', status: 'Sent', sentAt: '2026-09-10', daysPending: 20 },
          { id: 'o4', offerCode: 'OF-4', candidate: 'Meera Iyer', job: 'React Developer', status: 'Under Negotiation', sentAt: '2026-09-15', daysPending: 15 },
        ], filtersApplied: args.filters };
      }
      return { total: 2, page: 1, totalPages: 1, compensationHidden: true, records: [
        { id: 'o1', offerCode: 'OF-1', candidate: 'Ravi Kumar', job: 'QA Engineer', status: 'Accepted', placementStatus: 'Pending' },
        { id: 'o2', offerCode: 'OF-2', candidate: 'Meera Iyer', job: 'React Developer', status: 'Accepted', placementStatus: 'Joined' },
      ], filtersApplied: args?.filters ?? {} };
    case 'count_placements': {
      const byStatus = { Pending: 2, Onboarding: 1, Joined: 2, Deferred: 0, Cancelled: 1 };
      const f = args?.filters ?? {};
      return { total: f.status ? byStatus[f.status] : 5, byStatus, filtersApplied: f };
    }
    case 'list_placements':
      return { total: 2, page: 1, totalPages: 1, records: [
        { id: 'p1', candidate: 'Ravi Kumar', job: 'QA Engineer', status: 'Pending', preBoardingStatus: 'In Progress', joiningDate: '2026-10-05' },
        { id: 'p2', candidate: 'Anil Das', job: 'Sales Lead', status: 'Pending', preBoardingStatus: 'Pending', joiningDate: '2026-10-12' },
      ], filtersApplied: args?.filters ?? {} };
    case 'get_hiring_funnel':
      return {
        total: 40, converted: 8, conversionRate: 20, pending: 12,
        buckets: {
          refer_leads: { label: 'Referral leads', count: 40 },
          applications: { label: 'Job applications', count: 15 },
          interviews: { label: 'Interviews', count: 7 },
          offers: { label: 'Offers', count: 4 },
          placements: { label: 'Placements (Onboarding / Joined / Deferred)', count: 3 },
          pre_boarding: { label: 'Pre-boarding', count: 2, concurrent: true },
          onboarded: { label: 'Onboarded (Employee role)', count: 5 },
        },
        filtersApplied: args?.filters ?? {},
      };
    case 'list_referral_leads':
      return { total: 1, page: 1, totalPages: 1, records: [
        { id: 'c1', candidate: 'Khushi Parmar', referredBy: 'Sami Shaikh', salesAgent: 'Neha Rao', job: 'QA Engineer', status: 'applied', linkType: 'Job link', claimedAt: '2026-09-01' },
      ], filtersApplied: args?.filters ?? {} };
    case 'count_meetings':
      return { total: 6, breakdown: { scheduled: 4, ended: 1, cancelled: 1 }, filtersApplied: args?.filters ?? {} };
    case 'list_meetings':
      if (args?.filters?.status === 'ended' || ['past', 'earlier_today'].includes(args?.filters?.when)) {
        return { total: 2, records: [
          { id: 'm1', title: 'Sprint planning', scheduledAt: '2026-09-30T03:30:00.000Z', durationMinutes: 60, meetingType: 'Video', status: 'ended', hosts: ['Asha Rao'], invitedCount: 5, hasRecording: true },
          { id: 'm2', title: 'HR sync', scheduledAt: '2026-09-30T04:45:00.000Z', durationMinutes: 30, meetingType: 'Video', status: 'ended', hosts: ['Vikram Shah'], invitedCount: 2, hasRecording: false },
        ], filtersApplied: args.filters };
      }
      return { total: 2, records: [
        { id: 'm1', title: 'Sprint planning', scheduledAt: '2026-09-30T05:30:00.000Z', durationMinutes: 60, meetingType: 'Video', status: 'scheduled', hosts: ['Asha Rao'], invitedCount: 5 },
        { id: 'm2', title: 'HR sync', scheduledAt: '2026-10-01T09:00:00.000Z', durationMinutes: 30, meetingType: 'Video', status: 'scheduled', hosts: ['Vikram Shah'], invitedCount: 2 },
      ] };
    case 'search_knowledge_base':
      return { found: true, answer: 'Full-time employees get 18 days of paid leave a year, accrued monthly.' };
    case 'get_work_schedule':
      return { self: !args?.person, name: args?.person || 'Eval Self', employeeId: 'DBS001',
        shift: { name: 'Day', timezone: 'Asia/Kolkata', startTime: '09:30', endTime: '18:30' },
        weekOff: ['Saturday', 'Sunday'], upcomingHolidays: [{ title: 'Diwali', date: '2026-11-08' }],
        upcomingHolidayCount: 1, leavesAllowed: 12 };
    case 'list_shifts':
      return { total: 2, shifts: [
        { id: 's1', name: 'Day', startTime: '09:30', endTime: '18:30', timezone: 'Asia/Kolkata', isActive: true },
        { id: 's2', name: 'Night', startTime: '21:00', endTime: '06:00', timezone: 'Asia/Kolkata', isActive: true },
      ] };
    case 'list_holidays':
      return { scope: args?.scope || 'mine', window: { from: '2026-09-29', to: null }, total: 2, holidays: [
        { title: 'Diwali', date: '2026-11-08', endDate: null }, { title: 'Christmas', date: '2026-12-25', endDate: null },
      ] };
    case 'get_org_structure':
      if (args?.metric === 'people_managers') return { metric: 'people_managers', total: 3, records: [{ name: 'Meera Iyer', directReports: 5 }] };
      return { metric: args?.metric || 'coverage', positionType: args?.positionType || 'all', total: 4, records: [
        { name: 'Ops Manager', type: 'manager', headName: 'Ravi Kumar' },
      ] };
    case 'get_training_progress':
      if (args?.mode === 'cohort' && args.scoreBand) {
        const quizScore = args.scoreBand === 'gte90' ? 94 : args.scoreBand === 'lt70' ? 58 : (args.minScore ?? 75);
        return { mode: 'cohort', course: args.course ?? null, position: args.position ?? null, total: 1, students: 1, records: [
          { student: 'Vikram Shah', course: args.course || 'React Basics', position: 'React Developer', status: 'In Progress', completion: 60, quizScore, atRisk: quizScore < 70 },
        ], filtersApplied: { scoreBand: args.scoreBand } };
      }
      if (args?.mode === 'cohort' && args.progress) {
        const status = { not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' }[args.progress] ?? 'In Progress';
        return { mode: 'cohort', course: args.course ?? null, position: args.position ?? null, total: 1, students: 1, records: [
          { student: 'Asha Rao', course: args.course || 'React Basics', position: args.position || 'React Developer', status,
            completion: status === 'Completed' ? 100 : status === 'Not Started' ? 0 : 45, quizScore: null, atRisk: false },
        ], filtersApplied: { progress: args.progress } };
      }
      if (args?.mode === 'cohort') {
        return { mode: 'cohort', course: args.course ?? null, position: args.position ?? null, total: 2, students: 2,
          cohort: { assignments: 10, students: 8, completed: 4, inProgress: 3, notStarted: 3, completionRate: 40, avgCompletion: 55, avgQuizScore: 78, withQuizScore: 6, atRisk: 1 },
          records: [
            { student: 'Asha Rao', course: args.course || 'React Basics', position: args.position || 'React Developer', status: 'In Progress', completion: 45, quizScore: 72, atRisk: false },
            { student: 'Vikram Shah', course: args.course || 'React Basics', position: args.position || 'React Developer', status: 'Completed', completion: 100, quizScore: 91, atRisk: false },
          ] };
      }
      if (args?.mode === 'position_map') {
        return { mode: 'position_map', total: 1, records: [
          { position: args.position || 'Java Developer', department: 'Engineering', courses: ['Java 101', 'Spring'], courseCount: 2, folders: ['Backend'], employeeCount: 6, studentCount: 5 },
        ] };
      }
      return { person: args?.person || 'Eval Self', self: !args?.person, total: 2, courses: [
        { module: 'React Basics', status: 'completed', percentage: 100 }, { module: 'Node APIs', status: 'in-progress', percentage: 40 },
      ] };
    case 'get_attendance':
      return { person: { name: 'Eval Self', employeeId: 'DBS001', self: !args?.person }, window: args?.window ?? { from: '2026-09-01', to: '2026-09-29' },
        total: 2, statusBreakdown: { Present: 1, Leave: 1 }, records: [
          { date: '2026-09-29', status: 'Present', punchIn: '09:32', punchOut: '18:05', hours: 8.55 },
          { date: '2026-09-26', status: 'Leave', leaveType: 'sick' },
        ] };
    case 'get_attendance_summary':
      return { window: args?.window, total: 40, avgDailyPresent: 34, daysCounted: 1,
        perDay: [{ date: args?.window?.from ?? '2026-09-28', counts: { Present: 34, Absent: 3, Leave: 3, Holiday: 0, WeekOff: 0, Incomplete: 0 } }] };
    case 'count_leave_requests':
      if (args?.groupBy === 'employee') {
        return { groupBy: 'employee', statusCounted: 'approved', total: 2, groups: [
          { rank: 1, name: 'Asha Rao', leaveDays: 4, requestCount: 2 }, { rank: 2, name: 'Vikram Shah', leaveDays: 2, requestCount: 1 },
        ] };
      }
      return { total: 5, groupBy: 'status', breakdown: { pending: 3, approved: 2, rejected: 0, cancelled: 0 }, filtersApplied: args?.filters ?? {} };
    case 'list_leave_requests':
      return { total: 1, records: [{ id: 'l1', person: 'Asha Rao', leaveType: 'sick', status: 'pending', from: '2026-09-30', to: '2026-10-01', days: 2 }] };
    case 'who_is_on_leave_today':
      return { total: 1, scope: 'all', records: [{ name: 'Vikram Shah', employeeId: 'DBS007', leaveType: 'casual', from: '2026-09-29', to: '2026-09-29' }] };
    case 'list_backdated_requests':
      return { total: 1, breakdown: { pending: 1, approved: 0, rejected: 0, cancelled: 0 }, records: [
        { id: 'b1', person: 'Asha Rao', status: 'pending', days: 1, from: '2026-09-25', to: '2026-09-25' },
      ] };
    // ─── Wave 1 tools: minimal skeletons of each real execute's happy-path shape ───
    // Wave 1 canned results echo the call's filters / groupBy: a row that contradicts the filter the model
    // just sent (a finished session for "active", status groups for groupBy caller) made it re-query, which
    // the scorer counts as an extra call — noise, not a routing error.
    case 'count_call_records': {
      const f = args?.filters ?? {};
      const groupsBy = {
        status: [{ value: 'completed', count: 8 }, { value: 'missed', count: 4 }],
        day: [{ value: f.calledBetween?.from ?? '2026-09-28', count: 7 }, { value: f.calledBetween?.to ?? '2026-09-29', count: 5 }],
        caller: [{ value: 'Asha Rao', count: 8 }, { value: 'Vikram Shah', count: 4 }],
        hangupBy: [{ value: 'Callee', count: 5 }, { value: 'Caller', count: 4 }, { value: null, count: 3 }],
      };
      return args?.groupBy
        ? { total: 12, groupBy: args.groupBy, groups: groupsBy[args.groupBy] ?? [], filtersApplied: f }
        : { total: 12, filtersApplied: f };
    }
    case 'list_call_records': {
      const f = args?.filters ?? {};
      return { total: 1, records: [
        { id: 'cr1', when: '2026-09-29T10:00:00.000Z', person: 'Priya Shah', category: 'candidate', callType: f.callType ?? 'job_application',
          direction: f.direction ?? 'outbound', provider: f.provider ?? 'plivo', durationSeconds: 184, status: f.status ?? 'completed',
          placedBy: f.mine ? 'Eval Self' : 'Asha Rao', outcome: 'interested', recordingAvailable: true },
      ], filtersApplied: f };
    }
    case 'get_call_record':
      return {
        call: { id: 'cr1', when: '2026-09-29T10:00:00.000Z', person: args?.person || 'Priya Shah', category: 'candidate',
          callType: 'job_application', direction: 'outbound', durationSeconds: 184, status: 'completed', outcome: 'interested', recordingAvailable: true },
        aiInsights: { source: 'AI extraction of the call', summary: 'The candidate said they are interested in the QA role.', interest: 'interested' },
        transcript: null,
        recordings: { bolna: { available: true, channel: 'agent_only' }, plivo: { available: false }, twilio: { available: false } },
      };
    case 'list_call_followups':
      return { kind: args?.kind ?? 'callbackRequested', total: 1, records: [
        { applicationId: 'a1', applicant: 'Ranveer Singh', job: 'QA Engineer', applicationStatus: 'Applied', appliedAt: '2026-09-25T09:00:00.000Z',
          callbackAt: '2026-09-30T11:00:00.000Z', callbacksBooked: 1, verificationCallStatus: 'callback_scheduled' },
      ], ...(args?.kind === 'notYetCalled' ? { byVerificationStatus: { 'never attempted': 1 } } : {}), filtersApplied: {} };
    case 'list_email_activity':
      return { total: 1, records: [
        { to: args?.filters?.person?.includes('@') ? args.filters.person : 'ravi.kumar@example.com', person: 'Ravi Kumar',
          type: args?.filters?.type ?? 'offer-letter', subject: 'Your DharwinOne email', status: args?.filters?.status ?? 'sent',
          error: null, sentAt: '2026-09-29T10:00:00.000Z', attemptedAt: '2026-09-29T10:00:00.000Z' },
      ], filtersApplied: args?.filters ?? {} };
    case 'get_call_metrics':
      return { totalCalls: 40, byStatus: { completed: 28, 'no-answer': 9, failed: 3 }, finishedCalls: 40, answeredCalls: 28,
        answerRate: 0.7, avgDurationSeconds: 142, failedCalls: 3, interestConfirmedRate: 0.4,
        notYetCalledApplicants: 6, callbacksDue: 2, callbacksOverdue: 1, filtersApplied: args?.filters ?? {} };
    case 'get_interview':
      return {
        interview: { id: 'm1', candidate: args?.candidate || 'Ravi Kumar', jobPosition: args?.jobPosition || 'QA Engineer', status: 'ended',
          result: 'selected', scheduledAt: '2026-09-28T09:00:00.000Z', scheduledBy: 'Asha Rao', interviewers: 'Asha Rao, Vikram Shah',
          panel: [{ name: 'Asha Rao', role: 'recruiter' }, { name: 'Vikram Shah', role: 'interviewer' }] },
        recording: { recorded: true, recordingCount: 1 },
        aiSummary: { executiveSummary: 'Strong test automation answers.', decisions: ['Move to offer'], nextSteps: ['Share offer'] },
        evaluations: [{ evaluator: 'Vikram Shah', weightedScore: 4.2, isComplete: true }],
        resultMissing: false,
        feedbackMissing: false,
        history: [{ action: 'interview.result.update', by: 'Asha Rao', at: '2026-09-29T12:00:00.000Z', from: 'pending', to: 'selected' }],
      };
    case 'get_interview_transcript':
      return {
        interview: { id: 'm1', candidate: args?.candidate || 'Ravi Kumar', jobPosition: 'QA Engineer', scheduledAt: '2026-09-28T09:00:00.000Z', status: 'ended' },
        transcriptAvailable: true,
        utteranceCount: 40,
        speakers: [{ name: 'Ravi Kumar', role: 'candidate', utterances: 20 }, { name: 'Asha Rao', role: 'interviewer', utterances: 20 }],
        windows: [{ from: '0:00', to: '5:10', excerpt: 'Asha Rao: Tell me about test automation. Ravi Kumar: I have built Selenium and Playwright suites.' }],
        ...(args?.includeFullText ? { fullText: '[0:00] Asha Rao: Tell me about test automation.\n[0:05] Ravi Kumar: I have built Selenium and Playwright suites.' } : {}),
      };
    case 'get_offer':
      return { id: 'o1', offerCode: args?.offerCode || 'OF-1', candidate: args?.candidate || 'Ravi Kumar', job: 'QA Engineer', status: 'Sent',
        preparedBy: 'Asha Rao', sentAt: '2026-09-20', markedSentBy: 'Asha Rao', markedSentAt: '2026-09-20T10:00:00.000Z', daysPending: 10, joiningDate: '2026-10-15', letter: { pdfUrl: null }, compensationHidden: true };
    case 'get_placement':
      return { id: 'p1', candidate: args?.candidate || 'Ravi Kumar', job: 'QA Engineer', offerCode: 'OF-1', status: 'Pending', joiningDate: '2026-10-05',
        holdsEmployeeRole: false, firstBlockingStep: { step: 'Background verification', detail: 'Background verification is Pending.' },
        steps: [{ step: 'Pre-boarding', status: 'In progress' }, { step: 'Background verification', status: 'Pending' }],
        auditTrail: [{ action: 'status.change', from: 'Pending', to: 'Onboarding', by: 'Asha Rao', at: '2026-09-25T10:00:00.000Z' }] };
    case 'list_documents':
      if (args?.cohort) {
        return { total: 1, records: [{ name: 'Meera Nair', counts: { uploaded: 3, pendingReview: 0, approved: 2, rejected: 1, missing: 1 },
          rejected: ['Passport'], missing: ['Offer letter (signed)'] }], placementsScanned: 4, filtersApplied: { cohort: args.cohort } };
      }
      return { name: args?.person || 'Meera Nair', counts: { uploaded: 3, pendingReview: 0, approved: 2, rejected: 1, missing: 1 },
        documents: [{ label: 'Passport', status: 'rejected', reason: 'Blurry scan' }], missing: [{ label: 'Offer letter (signed)' }], expiries: [] };
    case 'get_job_stats':
      return args?.rankBy
        ? { rankBy: args.rankBy, total: 2, jobs: [
          { jobId: 'eval-job-1', title: 'Eval Job 1', status: 'Active', daysOpen: 40, applications: args.rankBy === 'zero_applications' ? 0 : 6,
            interviewed: args.rankBy === 'no_interviews' ? 0 : 2, vacanciesLeft: 1 },
          { jobId: 'eval-job-2', title: 'Eval Job 2', status: 'Active', daysOpen: 25, applications: args.rankBy === 'zero_applications' ? 0 : 3,
            interviewed: args.rankBy === 'no_interviews' ? 0 : 1, vacanciesLeft: 2 },
        ], jobsConsidered: 9, filtersApplied: args.filters ?? {} }
        : { job: { jobId: 'eval-job-1', title: args?.title || 'Eval Job', status: 'Active', daysOpen: 30 },
          applications: { total: 5, byStage: { Applied: 3, Interview: 2 }, lastApplicationAt: '2026-09-28' },
          zeroApplications: false, hireRatePercent: 0, vacancies: 2, hired: 0, vacanciesLeft: 2 };
    case 'get_referral':
      return { total: 1, records: [{ candidate: args?.person || 'Priya Sharma', referred: true, referredBy: 'Sami Shaikh', salesAgent: 'Neha Rao',
        channel: 'Share link', job: 'QA Engineer', referredAt: '2026-09-01', status: 'applied' }], notCaptured: ['who the link was shared with'] };
    case 'get_referral_stats':
      if (args?.salesAgent) {
        return { salesAgent: args.salesAgent === 'me' ? 'Eval Self' : args.salesAgent, self: args.salesAgent === 'me', referred: 20, applied: 12, offers: 4, joined: 3, joinRatePercent: 15,
          avgReferralToJoiningDays: 34, stuck: { total: 3, byStage: [{ stage: 'interview', count: 2, avgDaysInStage: 12, oldestDaysInStage: 20, leadsWithStageDate: 2 }, { stage: 'offer', count: 1, avgDaysInStage: 9, oldestDaysInStage: 9, leadsWithStageDate: 1 }] }, monthOverMonth: { thisMonth: { referred: 5, joined: 1 }, lastMonth: { referred: 4, joined: 1 } } };
      }
      return { rankBy: args?.rankBy ?? 'referred', total: 2, agents: [
        { salesAgent: 'Neha Rao', referred: 20, applied: 12, offers: 4, joined: 3, joinRatePercent: 15 },
        { salesAgent: 'Sami Shaikh', referred: 10, applied: 5, offers: 1, joined: 1, joinRatePercent: 10 },
      ], salesAgentsWithLeads: 2 };
    case 'list_activity': {
      const f = args?.filters ?? {};
      const at = f.between?.from ? `${f.between.from}T11:00:00.000Z` : '2026-09-29T11:00:00.000Z';
      if (f.target) {
        return { total: 1, scope: 'everyone', records: [
          { id: 'al3', at, actor: f.actor ?? 'Asha Rao', action: 'candidate.update', group: 'Employees', targetType: f.targetType ?? 'Employee',
            target: f.target, changes: [{ field: 'designation', from: 'QA Engineer', to: 'Senior QA Engineer' }] },
        ], filtersApplied: f };
      }
      return { total: 2, scope: 'everyone', records: [
        { id: 'al1', at, actor: f.actor ?? 'Priya Rao', action: 'user.login', group: 'Accounts', targetType: null, target: null, changes: null },
        { id: 'al2', at, actor: f.actor ?? 'Asha Rao', action: 'role.update', group: 'Roles', targetType: 'Role', target: 'Recruiter',
          changes: [{ field: 'permissions', from: 'jobs.read', to: 'jobs.read, jobs.manage' }] },
      ], filtersApplied: f };
    }
    case 'list_impersonations': {
      const f = args?.filters ?? {};
      const startedAt = f.between?.from ? `${f.between.from}T08:00:00.000Z` : '2026-09-29T08:00:00.000Z';
      return { total: 1, records: [
        { id: 'im1', admin: 'Asha Rao', target: 'Priya Rao', startedAt,
          endedAt: f.noEndRecorded ? null : startedAt.replace('T08:00', 'T08:12'), durationMinutes: f.noEndRecorded ? null : 12 },
      ], reason: 'not captured in DharwinOne', pagesViewed: 'not captured in DharwinOne', filtersApplied: f };
    }
    case 'what_can_i_do':
      return { roles: ['Recruiter'], fullAccess: false, modules: [
        { module: 'ATS', areas: [{ area: 'Jobs', can: ['view', 'add'] }, { area: 'Candidates', can: ['view'] }] },
      ], modulesWithoutAccess: ['Settings', 'Payroll'], note: 'Capabilities come from your roles.' };
    case 'get_reporting_chain': {
      const mode = args?.mode || 'chain';
      if (mode === 'chain') {
        return { mode, person: args?.person || 'Priya Sharma', designation: 'QA Engineer', onChart: true, chain: [
          { level: 'teamLead', unit: 'QA', head: 'Rahul Verma' }, { level: 'manager', unit: 'Engineering', head: 'Anita Desai' },
        ], reportingManager: 'Rahul Verma' };
      }
      if (mode === 'direct_reports') {
        return { mode, person: args?.person || 'Anita Desai', total: 2, records: [
          { name: 'Rahul Verma', employeeId: 'DBS010', designation: 'QA Lead' }, { name: 'Priya Sharma', employeeId: 'DBS011', designation: 'QA Engineer' },
        ] };
      }
      if (mode === 'group_moves') {
        return { mode, total: 1, records: [
          { employee: args?.person || 'Priya Sharma', fromDepartment: 'QA', toDepartment: 'Platform', type: 'department',
            effectiveDate: args?.movedBetween?.from ?? '2026-08-01', approvedBy: 'Anita Desai' },
        ] };
      }
      return { mode, total: 1, totalActiveEmployees: 40, records: [{ name: 'Priya Sharma', designation: 'QA Engineer' }] };
    }
    case 'get_allocation':
      if (args?.mode === 'can_assign') {
        return { mode: 'can_assign', person: args.person, project: args.project, eligible: true,
          reason: 'On 1 other active project(s) — under the limit of 2.', activeProjectsElsewhere: 1, alreadyOnProject: false, maxActiveProjects: 2 };
      }
      if (args?.mode === 'list') {
        return { mode: 'list', bucket: args.bucket, total: 1, records: [
          { name: 'Asha Rao', designation: 'React Developer', activeProjects: Number(String(args.bucket).match(/projects_(\d)/)?.[1] ?? 1),
            openTasks: args.bucket === 'overloaded' ? (args.overloadAbove ?? 9) + 3 : 0 },
        ], maxActiveProjects: 2 };
      }
      return { mode: 'summary', total: 20, byActiveProjects: { 0: 5, 1: 12, 2: 3, '3+': 0 }, atOrOverLimit: 3,
        noActiveTasks: 4, unallocated: 2, overloaded: 1, overloadAbove: 10, maxActiveProjects: 2 };
    case 'get_meeting':
      return { found: true, meeting: { id: 'm1', title: args?.title || 'Sprint planning', status: 'ended', scheduledAt: '2026-09-29T05:30:00.000Z',
        durationMinutes: 60, hosts: ['Asha Rao'], invitedCount: 3,
        attendees: [{ name: 'Vikram Shah', role: 'participant' }, { name: 'Ravi Kumar', role: 'participant' }], recorded: true, recordingCount: 1,
        recordingLink: 'https://example.com/recording/m1 (signed, expires)',
        summary: { executiveSummary: 'Release planning.', decisions: ['Ship the release on 2026-10-10'],
          actionItems: [{ text: 'Update the release notes', owner: 'Vikram Shah' }] } } };
    case 'search_my_mailbox':
      if (args?.threadId) {
        return { found: true, thread: { threadId: args.threadId, accountId: args.accountId ?? 'a1', mailbox: 'eval.self@example.com',
          subject: 'Invoice for September', messageCount: 1, messages: [
            { from: 'Acme Billing', to: 'eval.self@example.com', date: '2026-09-28T09:00:00.000Z', subject: 'Invoice for September',
              text: 'Please find the September invoice attached; due 2026-10-15.' },
          ] } };
      }
      return { connected: true, mailboxes: ['eval.self@example.com'], total: 1, moreAvailable: false, threads: [
        { threadId: 't1', accountId: 'a1', mailbox: 'eval.self@example.com', subject: 'Invoice for September', from: 'Acme Billing',
          date: '2026-09-28T09:00:00.000Z', snippet: 'Please find the September invoice attached.', messageCount: 1 },
      ] };
    case 'search_chat':
      return { total: 1, messages: [
        { conversationId: 'cv1', conversation: 'Release squad', conversationType: 'group', author: 'Ravi Kumar', at: '2026-09-29T12:00:00.000Z',
          snippet: 'The release date is 2026-10-10; deadline for fixes is 2026-10-08.' },
      ], conversationsSearched: 4, conversationsTotal: 4, partial: false };
    case 'get_person_360': {
      const self = !args?.person;
      const person = { userId: 'eval-user-7', name: args?.person || 'Eval Self', roles: ['Employee'], self, candidate: false, employee: true };
      const ok = (summary, rows = []) => ({ status: 'ok', summary, rows });
      const notRecorded = (note) => ({ status: 'notRecorded', note });
      let sections;
      if (args?.focus === 'today') {
        sections = {
          attendanceToday: ok({ total: 1 }, [{ date: '2026-09-30', status: 'Present', punchIn: '09:32' }]),
          tasksDueToday: ok({ total: 1 }, [{ code: 'T-12', title: 'Fix login bug', status: 'in_progress', dueDate: '2026-09-30' }]),
          leaveToday: notRecorded('Not on approved leave today.'),
          meetingsToday: self ? notRecorded('No meetings today.') : { status: 'restricted', note: "Other people's meetings are not readable." },
        };
      } else if (args?.focus === 'pending') {
        sections = {
          openTasks: ok({ open: 2, overdue: 1, blocked: 0 }, [{ code: 'T-12', title: 'Fix login bug', status: 'in_progress', dueDate: '2026-09-29' }]),
          pendingLeave: ok({ total: 1 }, [{ leaveType: 'casual', status: 'pending', from: '2026-10-05', to: '2026-10-05', days: 1 }]),
          missingDocuments: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
          callbacksDue: notRecorded('No callbacks due.'),
          interviewsAwaitingResult: notRecorded('No ended interview waiting for a result.'),
          offerPending: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
        };
      } else {
        const all = {
          profile: ok({ name: person.name, roles: person.roles, employee: { designation: 'QA Engineer', department: 'QA', joiningDate: '2025-04-01' } }),
          referral: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
          applications: notRecorded('No job applications on record.'),
          calls: notRecorded('No call records match this name.'),
          interviews: notRecorded('No interviews on record.'),
          offer: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
          placement: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
          documents: notRecorded('Candidate-only section — they hold the Employee role, not the Candidate role.'),
          org: ok({ designation: 'QA Engineer', chain: [{ level: 'teamLead', unit: 'QA', head: 'Rahul Verma' }], reportingManager: 'Rahul Verma' }),
          attendance: ok({ window: { from: '2026-09-01', to: '2026-09-30' }, total: 21, statusBreakdown: { Present: 20, Absent: 1 } }),
          leave: ok({ total: 1 }, [{ leaveType: 'casual', status: 'approved', from: '2026-09-12', to: '2026-09-12', days: 1 }]),
          training: ok({ total: 3, completed: 2 }, [{ module: 'Playwright basics', status: 'completed', percentage: 100 }]),
          work: ok({ tasks: { total: 5, open: 2, overdue: 1, blocked: 0 }, projectsFromTasks: ['Apollo'] }),
          activity: ok({ total: 1 }, [{ at: '2026-09-25T10:00:00.000Z', actor: 'Asha Rao', action: 'candidate.update', target: person.name }]),
          externalJobs: { status: 'notCaptured', note: 'External-job (bench marketing) activity is not captured in DharwinOne per person.' },
        };
        const wanted = args?.sections?.length ? new Set(args.sections) : null;
        sections = wanted ? Object.fromEntries(Object.entries(all).filter(([k]) => wanted.has(k))) : all;
      }
      return { person, focus: args?.focus ?? 'all', today: '2026-09-30', sections };
    }
    case 'find_duplicate_people': {
      const by = args?.by ?? 'both';
      const fields = by === 'both' ? ['email', 'phone'] : [by];
      const groups = fields.map((f) => ({
        matchedOn: f, value: f === 'email' ? 'priya.sharma@example.com' : '9876543210', size: 2,
        people: [{ id: 'e1', name: 'Priya Sharma', ownerUserId: 'u1' }, { id: 'e2', name: 'Priya S', ownerUserId: 'u2' }],
      }));
      return { by, population: args?.population ?? 'all', totalGroups: groups.length,
        byField: Object.fromEntries(fields.map((f) => [f, 1])), groups };
    }
    case 'get_attention_digest': {
      const window = { from: args?.window?.from ?? '2026-09-30', to: args?.window?.to ?? args?.window?.from ?? '2026-09-30' };
      const mine = args?.scope === 'mine';
      const compare = args?.compareTo === 'previous';
      const all = [
        { id: 'callbacks_overdue', label: 'Callbacks overdue', module: 'recruitment', severity: 'high', source: 'list_call_followups', status: 'ok', count: 3,
          rows: [{ applicant: 'Ravi Kumar', job: 'QA Engineer', callbackAt: '2026-09-29T11:00:00.000Z' }], windowed: false },
        { id: 'failed_calls', label: 'Failed calls', module: 'recruitment', severity: 'medium', source: 'list_call_records', status: 'ok', count: 2,
          rows: [{ candidate: 'Meera Nair', status: 'failed' }], windowed: true, ...(compare ? { compare: { now: 2, before: 5, delta: -3 } } : {}) },
        { id: 'pending_leave', label: 'Pending leave requests', module: 'hr', severity: 'medium', source: 'list_leave_requests', status: 'ok', count: 4,
          rows: [{ person: 'Asha Rao', leaveType: 'casual', from: '2026-10-02' }], windowed: false },
        { id: 'overdue_tasks', label: 'Overdue tasks', module: 'pm', severity: 'medium', source: 'list_tasks', status: 'ok', count: 1,
          rows: [{ code: 'T-12', title: 'Fix login bug', dueDate: '2026-09-28' }], windowed: false },
        { id: 'employees_no_project', label: 'Employees on no active project', module: 'bench', severity: 'low', source: 'get_allocation', status: 'ok', count: 5,
          rows: [{ name: 'Vikram Shah', designation: 'React Developer' }], windowed: false },
      ];
      const inModule = all.filter((i) => !args?.module || args.module === 'all' || i.module === args.module);
      const mineIds = new Set(['failed_calls', 'pending_leave', 'overdue_tasks']);
      const items = mine ? inModule.filter((i) => mineIds.has(i.id)) : inModule;
      return {
        scope: args?.scope ?? 'all', module: args?.module ?? 'all', window, items, restricted: [], failed: [],
        ...(mine ? { notScopedToYou: inModule.filter((i) => !mineIds.has(i.id)).map((i) => i.label) } : {}),
        ...(compare ? { compareTo: 'previous', previousWindow: { from: '2026-09-29', to: '2026-09-29' },
          noWindow: items.filter((i) => !i.windowed).map((i) => i.label) } : {}),
      };
    }
    case 'get_operations_summary': {
      const module = args?.module ?? 'recruitment';
      const window = { from: args?.window?.from ?? '2026-09-30', to: args?.window?.to ?? args?.window?.from ?? '2026-09-30' };
      const metricsByModule = {
        recruitment: [['open_jobs', 'Open jobs (Active)', 'count_jobs', 12], ['applications', 'Applications', 'count_applications', 140],
          ['interviews', 'Interviews scheduled in the window', 'count_interviews', 9], ['offers', 'Offers created in the window', 'count_offers', 3],
          ['joiners', 'Joined in the window', 'count_placements', 1]],
        hr: [['employees', 'Current employees', 'count_employees', 40], ['present_today', 'Present today', 'get_attendance_summary', 35],
          ['on_leave_today', 'On leave today', 'who_is_on_leave_today', 2], ['onboarding', 'Placements in onboarding', 'count_placements', 3]],
        pm: [['projects', 'Projects', 'count_projects', 6], ['open_tasks', 'Open tasks', 'count_tasks', 48],
          ['utilisation', 'Employees by active projects', 'get_allocation', 20]],
        bench: [['unallocated', 'Employees on no active project', 'get_allocation', 5], ['external_jobs', 'External jobs (Active)', 'count_jobs', 30]],
      };
      return {
        module, window,
        metrics: (metricsByModule[module] ?? []).map(([id, label, source, value]) => ({ id, label, source, status: 'ok', value })),
        restricted: [], failed: [],
        attention: [{ id: 'pending_leave', label: 'Pending leave requests', module: 'hr', severity: 'medium', source: 'list_leave_requests', status: 'ok', count: 4, rows: [], windowed: false }]
          .filter((i) => i.module === module),
      };
    }
    case 'run_data_quality_checks': {
      const all = [
        { id: 'incomplete_employee_profiles', label: 'Employee profiles not 100% complete', count: 7, sample: [{ name: 'Asha Rao', profileCompletion: 60 }] },
        { id: 'candidates_no_skills', label: 'Candidates with no skills', count: 12, sample: [{ name: 'Ravi Kumar' }] },
        { id: 'candidates_no_education', label: 'Candidates with no education', count: 9, sample: [{ name: 'Meera Nair' }] },
        { id: 'candidates_no_experience', label: 'Candidates with no work experience', count: 15, sample: [{ name: 'Karan Mehta' }] },
        { id: 'duplicate_phones', label: 'Duplicate phone numbers', count: 2, sample: [{ matchedOn: 'phone' }] },
        { id: 'offers_missing_terms', label: 'Offers missing salary or joining date', count: 1, sample: [{ candidate: 'Ravi Kumar', offerCode: 'OF-1', missing: 'joining date' }] },
        { id: 'tasks_no_due_date', label: 'Tasks with no due date', count: 4, sample: [{ code: 'T-40', title: 'Write docs' }] },
      ].map((c) => ({ ...c, status: 'ok', source: `eval source for ${c.id}` }));
      const checks = args?.checks?.length ? all.filter((c) => args.checks.includes(c.id)) : all;
      const sampleSize = args?.sampleSize ?? 5;
      const shown = checks.map((c) => ({ ...c, sample: c.sample.slice(0, sampleSize) }));
      return { checks: shown, flagged: shown.filter((c) => c.count > 0).length, restricted: [], failed: [], notCaptured: [] };
    }
    case 'run_cross_check': {
      const query = args?.query ?? 'passed_interview_no_offer';
      const a = args?.args ?? {};
      const extra = query === 'applications_unchanged'
        ? { businessDays: a.businessDays ?? 5, noChangeSince: '2026-09-23', basis: { statusChangedAt: 1, updatedAt: 1 }, holidaysSkipped: 0 }
        : query === 'bench_matches_recent_jobs'
          ? { jobs: Array.from({ length: a.jobCount ?? 5 }, (_, i) => ({ jobId: `eval-job-${i + 1}`, title: `${a.jobKeyword ?? 'Eval'} Developer ${i + 1}` })) }
          : {};
      const row = query === 'applications_unchanged'
        ? { name: 'Ravi Kumar', job: 'QA Engineer', status: 'Applied', lastChange: '2026-09-18', lastChangeBasis: 'statusChangedAt' }
        : { name: 'Ravi Kumar', employeeId: 'DBS021', job: 'QA Engineer' };
      return {
        query, status: 'ok',
        definition: `Eval definition for ${query}${Object.keys(a).length ? ` with ${JSON.stringify(a)}` : ''}.`,
        total: 2, atLeast: false,
        sets: [{ section: 'Set A', status: 'ok', total: 10 }, ...(query === 'applications_unchanged' ? [] : [{ section: 'Set B', status: 'ok', total: 8 }])],
        rows: [row, { ...row, name: 'Meera Nair', ...(row.employeeId ? { employeeId: 'DBS022' } : {}) }],
        notes: [], ...extra,
      };
    }
    case 'get_recruitment_funnel': {
      const window = args?.window ?? { from: '2026-09-01', to: '2026-09-30' };
      const conversions = [
        { from: 'application', to: 'interview', numerator: 40, denominator: 100, rate: 40 },
        { from: 'application', to: 'screening', numerator: 10, denominator: 20, rate: 50, population: 'history' },
        { from: 'screening', to: 'interview', numerator: 6, denominator: 10, rate: 60, population: 'history' },
        { from: 'interview', to: 'offer', numerator: 12, denominator: 40, rate: 30 },
        { from: 'offer', to: 'accepted', numerator: 8, denominator: 12, rate: 66.7 },
        { from: 'accepted', to: 'onboarding', numerator: 6, denominator: 8, rate: 75 },
        { from: 'onboarding', to: 'hired', numerator: 5, denominator: 6, rate: 83.3 },
      ];
      const funnel = {
        status: 'ok', cohort: { applications: 100, truncated: false }, applications: 100,
        basis: { history: 20, derived: 70, none: 10, approximate: 0 },
        stages: [{ stage: 'application', reached: 100 }, { stage: 'screening', reached: 10, population: 'history', notCaptured: 80 },
          { stage: 'interview', reached: 40 }, { stage: 'offer', reached: 12 }, { stage: 'accepted', reached: 8 },
          { stage: 'onboarding', reached: 6 }, { stage: 'hired', reached: 5 }],
        conversions,
        stageAging: [{ stage: 'interview', open: 10, avgDays: 9.5, maxDays: 21, withoutDate: 0 }],
        slowestStage: { from: 'interview', to: 'offer', n: 12, avgDays: 11.2, medianDays: 9 },
        cycleTime: { applicationToOnboarding: { n: 6, avgDays: 34, medianDays: 31 } },
      };
      return {
        window, ...(args?.jobId ? { jobId: args.jobId } : {}), ...(args?.recruiter ? { recruiter: args.recruiter === 'me' ? 'Eval User' : args.recruiter } : {}),
        funnel,
        recruiterWorkload: { status: 'ok', total: 2, medianTotal: 15, rows: [
          { recruiter: 'Asha Rao', openApplications: 14, openInterviews: 4, openOffers: 2, total: 20 },
          { recruiter: 'Vikram Shah', openApplications: 8, openInterviews: 1, openOffers: 1, total: 10 },
        ], sections: { interviews: 'ok', offers: 'ok' },
        note: 'Pending workload (open items per recruiter) — a workload comparison, not a measure of recruiter quality.' },
        notes: ['Reached = entered the stage or any later one. Screening is only dated in status history, so its counts use history-basis applications only (notCaptured = the rest).',
          'Onboarding and hired dates always come from the placement record (entered onboarding, joined).'],
        ...(args?.compareTo === 'previous' ? {
          previous: { window: { from: '2026-08-01', to: '2026-08-31' }, status: 'ok', cohort: { applications: 90, truncated: false },
            basis: { history: 0, derived: 80, none: 10, approximate: 0 }, stages: funnel.stages, conversions, slowestStage: funnel.slowestStage },
          change: conversions.map((c) => ({ from: c.from, to: c.to, rate: c.rate, previousRate: c.rate, delta: 0 })),
        } : {}),
      };
    }
    case 'explain_status': {
      const question = args?.question ?? 'why_unavailable';
      const rules = [
        { rule: 'Not resigned', source: 'employee.model.js employmentStatus', met: true, evidence: null },
        { rule: 'Under the 2-active-project limit', source: 'services/projectCapacity.js isAtProjectCapacity', met: false, evidence: 'On 2 active projects.' },
      ];
      return {
        question, person: args?.person || 'Priya Sharma', ...(args?.project ? { project: args.project } : {}),
        rules, conclusion: 'Blocked: Under the 2-active-project limit.', sections: { profile: 'ok', canAssign: 'ok' },
      };
    }
    case 'recommend': {
      const kind = args?.kind ?? 'follow_ups_today';
      const subjectArg = args?.project ?? args?.job ?? args?.team;
      return {
        kind, rules: [`Eval ranking rule for ${kind}.`],
        ...(args?.project ? { project: args.project } : {}), ...(args?.job ? { job: args.job } : {}), ...(args?.team ? { team: args.team } : {}),
        sections: { source: 'ok' }, total: 2,
        items: [
          { subject: 'Ravi Kumar', score: 90, reasons: [subjectArg ? `fits ${subjectArg}` : 'highest rule match'], evidence: { count: 2 } },
          { subject: 'Meera Nair', score: 70, reasons: ['second rule match'], evidence: { count: 1 } },
        ],
      };
    }
    case 'match_jobs_to_employee':
      return {
        person: args?.person || 'Priya Sharma', designation: 'QA Engineer', skills: ['Selenium', 'Playwright', 'Java'], skillsTotal: 3,
        total: 2, jobsSearched: 6,
        jobs: [
          { jobId: 'eval-job-1', title: 'QA Engineer', organisation: 'Acme Corp', score: 73, matchedSkills: ['selenium', 'java'], missingSkills: ['cypress'], titleMatchesDesignation: true },
          { jobId: 'eval-job-2', title: 'SDET', organisation: 'Acme Corp', score: 40, matchedSkills: ['playwright'], missingSkills: ['python'] },
        ],
        sections: { profile: 'ok', jobs: 'ok' },
      };
    // ─── actions domain: drafts only, shaped like createDraft's result for the call's args ───
    case 'resend_interview_invite': {
      const byId = /^[0-9a-f]{24}$/i.test(args?.interview ?? '');
      const candidate = !args?.interview || byId ? 'Ravi Kumar' : args.interview;
      return draftResult(`Re-send the invitation for ${candidate}'s interview`, [
        `Interview: "Interview: ${candidate} — QA Engineer" — ${candidate} · QA Engineer · 2 Oct 2026, 3:00 PM (IST)`,
        'Channel: email with a calendar invite, plus an in-app notification for recipients who have a DharwinOne login.',
        'Recipients (2):',
        '• Asha Rao (host, recruiter) — asha.rao@example.com',
        `• ${candidate} (candidate) — candidate@example.com`,
      ], [{ id: byId ? args.interview : '64d000000000000000000001', name: `${candidate} — QA Engineer` }], 'Re-send invitation');
    }
    case 'send_interview_booking_link': {
      const application = args?.application ?? '64a000000000000000000001';
      return draftResult('Email Ranveer Singh an interview booking link', [
        "To: Ranveer Singh — ranveer@example.com (the candidate profile's own email)",
        'Job: QA Engineer · application status Applied',
        'Channel: email only (no in-app notification).',
      ], [{ id: application, name: 'Ranveer Singh — QA Engineer' }], 'Send booking link');
    }
    case 'schedule_interview': {
      const application = args?.application ?? '64a000000000000000000001';
      const hosts = args?.hosts?.length ? args.hosts.join(', ') : 'Eval User';
      return draftResult("Schedule Ranveer Singh's interview for QA Engineer", [
        `When: ${args?.scheduledAt ?? '2026-10-15T15:00:00+05:30'} · ${args?.durationMinutes ?? 60} min · ${args?.interviewType ?? 'Video'}`,
        'Job: QA Engineer',
        `Panel (hosts): ${hosts}`,
        'Moves the application from Applied to Interview.',
        'No clashes found for the panel among interviews you can see.',
      ], [{ id: application, name: 'Ranveer Singh — QA Engineer' }], 'Schedule interview');
    }
    case 'request_documents': {
      const person = args?.person || 'Priya Sharma';
      const docs = args?.documents?.length ? args.documents : [{ label: 'Passport' }];
      return draftResult(`Request ${docs.length} document${docs.length === 1 ? '' : 's'} from ${person}`, [
        ...docs.map((d) => `Request "${d.label}" (type ${d.type || 'Other'}) from ${person}`),
        `Notify ${person}: in-app notice and email to their DharwinOne login.`,
      ], [{ id: 'e1', name: person }], 'Request documents');
    }
    case 'remind_pending_documents': {
      const person = args?.person || 'Priya Sharma';
      return draftResult(`Remind ${person} about 2 pending documents`, [
        `Remind ${person} about "Passport", "PAN card".`,
        `Notify ${person}: in-app notice and email to their DharwinOne login.`,
      ], [{ id: 'e1', name: person }], 'Send reminder');
    }
    case 'assign_training': {
      const people = namesOf(args?.people, 'Priya Shah');
      const module = args?.module || 'Java Basics';
      return draftResult(`Assign "${module}" to ${people.length} ${people.length === 1 ? 'person' : 'people'}`, [
        `Add to "${module}": ${people.join(', ')}.`,
        'Channel: in-app notification and email (unless they turned off course updates in their notification settings).',
        'Nobody already on the course is removed or notified.',
      ], people.map((name, i) => ({ id: `s${i + 1}`, name })), 'Assign course');
    }
    case 'send_course_reminder': {
      const people = namesOf(args?.people, 'Priya Shah');
      const module = args?.module || 'React Basics';
      return draftResult(`Remind ${people.length} ${people.length === 1 ? 'person' : 'people'} about "${module}"`, [
        `Recipients: ${people.join(', ')}.`,
        'Channel: in-app notification and email (unless they turned off course updates in their notification settings).',
      ], people.map((name, i) => ({ id: `s${i + 1}`, name })), 'Send reminder');
    }
    case 'create_task_plan': {
      const project = args?.project || 'Apollo';
      return draftResult(`Create 3 tasks in ${project}`, ['Define scope and milestones', 'Build the first release', 'Test and launch'],
        [{ id: 'p1', name: project }], 'Create tasks');
    }
    default:
      return NO_CANNED_RESULT;
  }
}

function parseArgsJson(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Wrap the REAL registry: keeps its real schemas/instructions/isHandoff and lazy
 * loading (so the live model sees the exact tool contracts it sees in prod), but
 * replaces `execute` with a fake that never touches Mongo, and `render` with a
 * no-op (rendering fidelity isn't what this eval measures).
 */
function wrapRegistryForEval(real) {
  return {
    schemas: real.schemas,
    instructions: real.instructions,
    lazy: real.lazy,
    isHandoff: real.isHandoff,
    isFindTools: real.isFindTools,
    domainOfTool: real.domainOfTool,
    loadDomains: real.loadDomains,
    parseFindToolsArgs: real.parseFindToolsArgs,
    render: () => null,
    async execute(name, rawArgs) {
      const args = parseArgsJson(rawArgs);
      return { ok: true, result: cannedResult(name, args) };
    },
  };
}

/**
 * Builds runAgent `deps` for one case run: `getAgentTools` is the real
 * registry wrapped per above; `step` is the real `llm.step` (hits the live
 * model) instrumented to record every tool call the model attempts —
 * including `handoff`, which runAgent short-circuits to null (the caller's fixed
 * reply) before it ever reaches `registry.execute` — plus per-step token usage.
 */
function buildInstrumentedDeps({ eager }) {
  const calls = [];
  const usage = { inputTokens: 0, outputTokens: 0, steps: 0 };

  async function getAgentTools(user, opts) {
    const real = await realGetAgentTools(user, eager ? { ...opts, eagerLimit: Infinity } : opts);
    return wrapRegistryForEval(real);
  }

  async function step(req) {
    usage.steps += 1;
    const res = await realLlmStep(req);
    for (const c of res.toolCalls) calls.push({ name: c.name, args: parseArgsJson(c.arguments) });
    if (res.usage) {
      usage.inputTokens += res.usage.input_tokens ?? 0;
      usage.outputTokens += res.usage.output_tokens ?? 0;
    }
    return res;
  }

  return { deps: { getAgentTools, step, resolveViewerRoleNames: async () => ['Administrator'] }, calls, usage };
}

// ─── Case runner ────────────────────────────────────────────────────────────

function buildMemDoc(ledger) {
  if (!ledger) return null;
  return { agentLedger: ledger.map((entry) => ({ at: new Date(), calls: entry.calls })) };
}

async function runCase(client, testCase, { eager }) {
  const history = [...(testCase.history ?? []), { role: 'user', content: testCase.question }];
  const memDoc = buildMemDoc(testCase.ledger);
  const { deps, calls, usage } = buildInstrumentedDeps({ eager });

  const startedAt = Date.now();
  let errored = null;
  try {
    await runAgent({ client, user: FAKE_USER, history, memDoc, requestId: `eval-${testCase.id}`, deps });
  } catch (err) {
    errored = err?.message || String(err);
  }
  const ms = Date.now() - startedAt;

  const handoffCalled = calls.some((c) => c.name === 'handoff');
  const findToolsCalled = calls.some((c) => c.name === FIND_TOOLS);
  const pass = !errored && evaluateExpect(testCase.expect, { calls, handoffCalled });

  return { id: testCase.id, pass, ms, calls, handoffCalled, findToolsCalled, errored, usage };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function percentile(sortedMs, p) {
  if (!sortedMs.length) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function formatCall(c) {
  return `${c.name}(${JSON.stringify(c.args)})`;
}

/** Every tool name an `expect` (and its `anyOf` alternatives) names. */
function expectedToolNames(expect) {
  if (!expect || typeof expect !== 'object') return [];
  return [
    ...(expect.tools ?? []),
    ...Object.keys(expect.args ?? {}),
    ...(expect.anyOf ?? []).flatMap(expectedToolNames),
  ];
}

/**
 * --check: no model calls. Every case file parses; ids are unique; every tool a case expects
 * or replays in its ledger is registered AND visible to FAKE_USER (else the case can never
 * pass); every rule exists; every registered tool has a canned result.
 */
async function checkCases(file) {
  const problems = [];
  const names = ['cases.json', ...fs.readdirSync(EVALS_DIR).filter((n) => n.endsWith('.cases.json')).sort()]
    .filter((n) => !file || n === file || n === `${file}.cases.json`);
  const cases = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(EVALS_DIR, name), 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('top level is not an array');
      cases.push(...parsed.map((c) => ({ ...c, file: name })));
    } catch (err) {
      problems.push(`${name}: ${err.message}`);
    }
  }

  const registered = new Set([...toolDomains.flatMap((d) => d.tools.map((t) => t.name)), 'handoff']);
  const visible = new Set((await realGetAgentTools(FAKE_USER, { eagerLimit: Infinity })).schemas.map((s) => s.name));
  const seenIds = new Set();
  for (const c of cases) {
    const where = `${c.file}:${c.id ?? '(no id)'}`;
    if (typeof c.id !== 'string' || !c.id) problems.push(`${where}: missing id`);
    else if (seenIds.has(c.id)) problems.push(`${where}: duplicate id`);
    seenIds.add(c.id);
    if (typeof c.question !== 'string' || !c.question.trim()) problems.push(`${where}: missing question`);
    if (!c.expect || typeof c.expect !== 'object') problems.push(`${where}: missing expect`);
    const rules = [c.expect?.rule, ...(c.expect?.anyOf ?? []).map((a) => a.rule)].filter(Boolean);
    for (const r of rules) if (!RULES[r]) problems.push(`${where}: unknown rule '${r}'`);
    const ledgerTools = (c.ledger ?? []).flatMap((e) => (e.calls ?? []).map((call) => call.tool));
    for (const tool of new Set([...expectedToolNames(c.expect), ...ledgerTools])) {
      if (!registered.has(tool)) problems.push(`${where}: unknown tool '${tool}'`);
      else if (!visible.has(tool)) problems.push(`${where}: '${tool}' is hidden from FAKE_USER (add its permission)`);
    }
  }
  for (const tool of registered) {
    if (tool !== 'handoff' && cannedResult(tool, {}) === NO_CANNED_RESULT) problems.push(`no canned result for '${tool}'`);
  }

  console.log(`checked ${cases.length} cases in ${names.length} files against ${registered.size} tools`);
  for (const p of problems) console.log(`  - ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log('ok');
}

async function main() {
  const { caseId, file, eager, min, check } = parseArgs(process.argv.slice(2));
  if (check) {
    await checkCases(file);
    return;
  }
  const allCases = loadCaseFiles(file);
  const cases = caseId ? allCases.filter((c) => c.id === caseId) : allCases;
  if (!cases.length) {
    console.error(caseId ? `No case with id '${caseId}'` : `No cases found${file ? ` in '${file}'` : ''}.`);
    process.exitCode = 1;
    return;
  }

  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const rows = [];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runCase(client, testCase, { eager });
    rows.push(outcome);
    const status = outcome.pass ? 'PASS' : 'FAIL';
    const callsText = outcome.calls.map(formatCall).join(', ') || '(no tool calls)';
    console.log(`[${status}] ${testCase.file}:${outcome.id} (${outcome.ms}ms) — ${callsText}`);
    if (outcome.errored) console.log(`  error: ${outcome.errored}`);
  }

  const passCount = rows.filter((r) => r.pass).length;
  const accuracy = (100 * passCount) / rows.length;
  const msSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const totalTokens = rows.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.outputTokens, 0);
  const avg = (key) => rows.reduce((sum, r) => sum + key(r), 0) / rows.length;
  const findToolsCases = rows.filter((r) => r.findToolsCalled).length;

  console.log('');
  console.log(`mode:     ${eager ? 'eager (--eager)' : 'default (lazy above the eager tool limit)'}`);
  console.log(`accuracy: ${passCount}/${rows.length} (${accuracy.toFixed(1)}%)`);
  console.log(`steps:    avg ${avg((r) => r.usage.steps).toFixed(2)} model steps per case`);
  console.log(`latency:  avg=${Math.round(avg((r) => r.ms))}ms p50=${percentile(msSorted, 50)}ms p95=${percentile(msSorted, 95)}ms`);
  console.log(`find_tools: called in ${findToolsCases}/${rows.length} cases`);
  console.log(`tokens:   ${totalTokens} (input+output, summed across every model step)`);

  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    console.log('');
    console.log('Failed cases:');
    for (const r of failed) {
      const callsText = r.calls.map(formatCall).join(', ') || '(no tool calls)';
      console.log(`  - ${r.id}: ${callsText}${r.errored ? ` [error: ${r.errored}]` : ''}`);
    }
  }

  if (accuracy < min) {
    console.error(`\naccuracy ${accuracy.toFixed(1)}% is below --min ${min}%`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
