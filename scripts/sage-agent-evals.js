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
// Usage:
//   node scripts/sage-agent-evals.js
//   node scripts/sage-agent-evals.js --case count-plain-react
//   node scripts/sage-agent-evals.js --min 80

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

import config from '../src/config/config.js';
import { runAgent } from '../src/services/chatAssistant/agent/runAgent.js';
import { getAgentTools as realGetAgentTools } from '../src/services/chatAssistant/agent/toolRegistry.js';
import { step as realLlmStep } from '../src/services/chatAssistant/agent/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.resolve(__dirname, '../src/services/chatAssistant/agent/__evals__/cases.json');

// ─── CLI args ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { caseId: null, min: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--case') out.caseId = argv[++i];
    else if (argv[i] === '--min') out.min = Number(argv[++i]);
  }
  return out;
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
  if (expect.handoff) {
    if (!ctx.handoffCalled) return false;
    if (expect.forbidSearchTerm && containsSearchTerm(ctx.calls, expect.forbidSearchTerm)) return false;
    return true;
  }

  // `answer: true` = Sage must reply itself (e.g. a definition), not hand off.
  if (expect.answer && ctx.handoffCalled) return false;

  const toolCalls = ctx.calls.filter((c) => c.name !== 'handoff');
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

// ─── Fake user (jobs.read only, no DB) ──────────────────────────────────────

const FAKE_USER = Object.freeze({
  id: 'eval-user-0000000000000001',
  name: 'Eval User',
  authContext: {
    permissions: new Set([
       'jobs.read', 'users.read', 'roles.read', 'employees.read', 'candidates.read',
       'interviews.read', 'students.read', 'chart.read', 'attendance.assign', 'students.manage',
       'projects.read', 'teams.read', 'tasks.read',
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
      return { job: jobRow(1, { title: args?.title || 'Eval Job', jobDescription: 'Eval-only canned description.' }) };
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
    case 'list_users':
      return {
        total: 4,
        users: [evalUserRow(1), evalUserRow(2), evalUserRow(3)],
        filtersApplied: args?.filters ?? {},
      };
    case 'get_user':
      return {
        kind: 'unique',
        identity: { userId: 'eval-user-1', name: args?.name || 'Eval Person', email: 'eval.person@example.com' },
        roles: [{ name: 'Recruiter', slug: 'recruiter', aliases: [], status: 'active', permissions: [] }],
        profiles: {},
        availableSections: [],
      };
    case 'list_roles':
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
    default:
      return { handoff: true };
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
 * Wrap the REAL registry: keeps its real schemas/instructions/isHandoff (so
 * the live model sees the exact tool contracts it sees in prod), but replaces
 * `execute` with a fake that never touches Mongo, and `render` with a no-op
 * (rendering fidelity isn't what this eval measures).
 */
function wrapRegistryForEval(real) {
  return {
    schemas: real.schemas,
    instructions: real.instructions,
    isHandoff: real.isHandoff,
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
 * including `handoff`, which runAgent short-circuits to null before it ever
 * reaches `registry.execute` — plus per-step token usage.
 */
function buildInstrumentedDeps() {
  const calls = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  async function getAgentTools(user, opts) {
    const real = await realGetAgentTools(user, opts);
    return wrapRegistryForEval(real);
  }

  async function step(req) {
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

async function runCase(client, testCase) {
  const history = [...(testCase.history ?? []), { role: 'user', content: testCase.question }];
  const memDoc = buildMemDoc(testCase.ledger);
  const { deps, calls, usage } = buildInstrumentedDeps();

  const startedAt = Date.now();
  let errored = null;
  try {
    await runAgent({ client, user: FAKE_USER, history, memDoc, requestId: `eval-${testCase.id}`, deps });
  } catch (err) {
    errored = err?.message || String(err);
  }
  const ms = Date.now() - startedAt;

  const handoffCalled = calls.some((c) => c.name === 'handoff');
  const pass = !errored && evaluateExpect(testCase.expect, { calls, handoffCalled });

  return { id: testCase.id, pass, ms, calls, handoffCalled, errored, usage };
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

async function main() {
  const { caseId, min } = parseArgs(process.argv.slice(2));
  const allCases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = caseId ? allCases.filter((c) => c.id === caseId) : allCases;
  if (!cases.length) {
    console.error(caseId ? `No case with id '${caseId}'` : 'No cases found.');
    process.exitCode = 1;
    return;
  }

  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const rows = [];
  for (const testCase of cases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runCase(client, testCase);
    rows.push(outcome);
    const status = outcome.pass ? 'PASS' : 'FAIL';
    const callsText = outcome.calls.map(formatCall).join(', ') || '(no tool calls)';
    console.log(`[${status}] ${outcome.id} (${outcome.ms}ms) — ${callsText}`);
    if (outcome.errored) console.log(`  error: ${outcome.errored}`);
  }

  const passCount = rows.filter((r) => r.pass).length;
  const accuracy = (100 * passCount) / rows.length;
  const msSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const totalTokens = rows.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.outputTokens, 0);

  console.log('');
  console.log(`accuracy: ${passCount}/${rows.length} (${accuracy.toFixed(1)}%)`);
  console.log(`latency:  p50=${percentile(msSorted, 50)}ms p95=${percentile(msSorted, 95)}ms`);
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
