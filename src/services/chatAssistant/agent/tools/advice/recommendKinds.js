/**
 * recommend's kinds. Each returns { rules, items, sections, ...notes }: `rules` is the fixed ranking rule in
 * words (so the model can say WHY), each item is { subject, score, reasons, evidence }. Every number comes
 * from a Wave 1 tool through runTool, except recruiter_capacity (see its ponytail note).
 */
import { SITUATIONS } from '../../../../../constants/smartNudge.situations.js';
import { CLOSED_APPLICATION_STATUSES } from '../../../../../constants/atsPipeline.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { andMongoFilters } from '../../../queryPlanner/entities/jobRank.js';
import { JOBS_ACCESS, jobScope } from '../jobs/common.js';
import { jobStatsDeps, applicationsByJob } from '../jobs/jobStats.js';
import {
  SECTION_ROWS, daysBetween, istDayOffset, nameCounts, normName, okResult, sectionStatus, todayIst,
} from './common.js';

const LIST = 50;
const SECTION_TIMEOUT_MS = 8000;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const call = (name, args, timeoutMs = SECTION_TIMEOUT_MS) => ({ name, args, timeoutMs });
const truncated = (r) => !!r && typeof r.total === 'number' && r.total > (r.records?.length ?? 0);
const item = (subject, score, reasons, evidence = null) => ({ subject, score, reasons, evidence });

/** Map of section key → status, so restricted / failed sections are named, never filled from elsewhere. */
function statusMap(keys, outs) {
  return Object.fromEntries(keys.map((k, i) => [k, sectionStatus(outs[i]).status]));
}

async function runKeyed(env, calls) {
  const keys = Object.keys(calls);
  const outs = await env.runAll(keys.map((k) => calls[k]));
  return { keys, outs, by: Object.fromEntries(keys.map((k, i) => [k, outs[i]])) };
}

/** meetingScope: interviews.manage sees every interview; interviews.read only the ones the viewer is on. */
async function seesAllInterviews(env) {
  return (await checkAccessRule({ anyOf: ['interviews.manage'] }, env.user)).ok;
}

// ── follow_ups_today ──────────────────────────────────────────────────────────
const SEVERITY_WEIGHT = Object.freeze({ high: 300, medium: 200, low: 100 });

async function followUpsToday(_args, env) {
  const rules = [
    'Your attention digest (scope mine): severity high → medium → low, then the larger open count.',
    'Only items with a "mine" filter count; the rest are listed in notScopedToYou.',
  ];
  const out = await env.run('get_attention_digest', { scope: 'mine' }, { timeoutMs: 13000 });
  const s = sectionStatus(out);
  if (s.status !== 'ok') return { rules, items: [], sections: { digest: s.status } };
  const r = out.result;
  const items = (r.items || [])
    .filter((i) => i.status === 'ok' && (i.count ?? 0) > 0)
    .map((i) => item(i.label, (SEVERITY_WEIGHT[i.severity] ?? 0) + Math.min(i.count, 99),
      [`severity ${i.severity}`, `${i.count} open`],
      { source: i.source ?? null, count: i.count, examples: (i.rows || []).slice(0, 3) }));
  return {
    rules,
    items,
    sections: { digest: 'ok' },
    ...(r.restricted?.length ? { restrictedItems: r.restricted } : {}),
    ...(r.failed?.length ? { failedItems: r.failed } : {}),
    ...(r.notScopedToYou?.length ? { notScopedToYou: r.notScopedToYou } : {}),
  };
}

// ── next_candidate_to_contact ─────────────────────────────────────────────────
const STALE_DAYS = SITUATIONS.application_stale.staleDays;
const INTERESTED_OUTCOMES = new Set(['fully_confirmed', 'partially_confirmed']);
const LOOKBACK_DAYS = 14;

async function nextCandidateToContact(_args, env) {
  const today = todayIst(env.now);
  const since = istDayOffset(env.now, -(LOOKBACK_DAYS - 1));
  const rules = [
    'Tier 1 (score 100+): callback overdue — more days overdue first.',
    'Tier 2 (score 90): callback requested, not yet due.',
    `Tier 3 (score 70): an AI verification call in the last ${LOOKBACK_DAYS} days classified fully / partially confirmed, ` +
      'and no interview for them in your interview list (the list rows carry the call outcome, not the "still interested" answer).',
    `Tier 4 (score 50+): applied at least ${STALE_DAYS} days ago (the stale-application threshold) and never called — older first.`,
    'One row per name, at its highest tier; lower tiers are kept as extra reasons.',
  ];
  const { keys, outs, by } = await runKeyed(env, {
    overdue: call('list_call_followups', { kind: 'callbackOverdue', limit: LIST }),
    requested: call('list_call_followups', { kind: 'callbackRequested', limit: LIST }),
    aiCalls: call('list_call_records', { filters: { callType: 'ai_agent', calledBetween: { from: since, to: today } }, limit: LIST }),
    interviews: call('list_interviews', { filters: { scheduledBetween: { from: since, to: istDayOffset(env.now, 30) } }, limit: LIST }),
    stale: call('list_call_followups', { kind: 'notYetCalled', appliedBetween: { to: istDayOffset(env.now, -STALE_DAYS) }, limit: LIST }),
  });
  const notes = [];
  const byName = new Map();
  const add = (name, it) => {
    const key = normName(name);
    if (!key) return;
    const prev = byName.get(key);
    if (!prev) return byName.set(key, it);
    const [hi, lo] = prev.score >= it.score ? [prev, it] : [it, prev];
    byName.set(key, { ...hi, reasons: [...new Set([...hi.reasons, ...lo.reasons])] });
  };

  for (const r of okResult(by.overdue)?.records || []) {
    const late = Math.max(daysBetween(r.callbackAt, env.now) ?? 0, 0);
    add(r.applicant, item(r.applicant, 100 + Math.min(late, 9), [`callback overdue${late ? ` by ${late} day(s)` : ''}`],
      { job: r.job ?? null, callbackAt: r.callbackAt ?? null, applicationStatus: r.applicationStatus ?? null }));
  }
  for (const r of okResult(by.requested)?.records || []) {
    add(r.applicant, item(r.applicant, 90, ['callback requested'],
      { job: r.job ?? null, callbackAt: r.callbackAt ?? null, applicationStatus: r.applicationStatus ?? null }));
  }
  const ai = okResult(by.aiCalls);
  const iv = okResult(by.interviews);
  if (ai && iv) {
    if (ai.aiFieldsHidden) notes.push('Tier 3 skipped — the AI call outcome needs the Call AI toggle (call-ai.read).');
    else {
      const interviewed = new Set((iv.records || []).map((m) => normName(m.candidate)));
      for (const r of ai.records || []) {
        if (!INTERESTED_OUTCOMES.has(r.outcome) || interviewed.has(normName(r.person))) continue;
        add(r.person, item(r.person, 70, [`AI call outcome ${r.outcome}, no interview`], { calledAt: r.when ?? null, outcome: r.outcome }));
      }
      if (truncated(iv)) notes.push('Your interview list was longer than the rows checked, so tier 3 may include someone with an interview.');
      if (!(await seesAllInterviews(env))) notes.push('Tier 3 only knows the interviews you are on; another recruiter\'s booking is not seen.');
    }
  } else {
    notes.push('Tier 3 skipped — it needs both the AI call list and your interview list (see sections).');
  }
  for (const r of okResult(by.stale)?.records || []) {
    const age = daysBetween(r.appliedAt, env.now);
    add(r.applicant, item(r.applicant, 50 + Math.min(Math.max((age ?? STALE_DAYS) - STALE_DAYS, 0), 19),
      [`applied ${age ?? 'unknown'} day(s) ago, never called`],
      { job: r.job ?? null, appliedAt: r.appliedAt ?? null, applicationStatus: r.applicationStatus ?? null }));
  }
  const cut = ['overdue', 'requested', 'aiCalls', 'stale'].filter((k) => truncated(okResult(by[k])));
  if (cut.length) notes.push(`Only the first ${LIST} rows of ${cut.join(', ')} were ranked.`);
  return { rules, items: [...byName.values()], sections: statusMap(keys, outs), notes };
}

// ── interview_order ───────────────────────────────────────────────────────────
async function interviewOrder(_args, env) {
  const rules = [
    'Awaiting interview = application at Screening or Shortlisted with no upcoming scheduled interview for that name.',
    'Score = days since applying (max 30) + 20 when the job deadline is within 7 days + 10 when openings are left ' +
      '− 50 when every opening is filled + 5 when Shortlisted.',
  ];
  const stage1 = await runKeyed(env, {
    screening: call('list_applications', { filters: { status: 'Screening' }, limit: LIST }),
    shortlisted: call('list_applications', { filters: { status: 'Shortlisted' }, limit: LIST }),
    upcoming: call('list_interviews', { filters: { status: 'scheduled', scheduledBetween: { from: todayIst(env.now), to: istDayOffset(env.now, 60) } }, limit: LIST }),
  });
  const { by } = stage1;
  const apps = [...(okResult(by.screening)?.records || []), ...(okResult(by.shortlisted)?.records || [])];
  const sections = statusMap(stage1.keys, stage1.outs);
  const notes = [];
  const upcoming = okResult(by.upcoming);
  if (!upcoming) notes.push('Could not check upcoming interviews, so some rows may already have one.');
  // The verified link is the interview's application id; candidate.name is free text, used only when unlinked.
  const bookedApps = new Set((upcoming?.records || []).map((m) => m.applicationId).filter(Boolean));
  const bookedNames = new Set((upcoming?.records || []).filter((m) => !m.applicationId).map((m) => normName(m.candidate)));
  if (upcoming && !(await seesAllInterviews(env))) {
    notes.push('Only interviews you are on are visible to you, so someone booked by another recruiter may still be listed.');
  }

  const titleCount = new Map();
  for (const a of apps) if (a.job) titleCount.set(a.job, (titleCount.get(a.job) || 0) + 1);
  const titles = [...titleCount.keys()].sort((x, y) => titleCount.get(y) - titleCount.get(x)).slice(0, 10);
  let jobFacts = new Map();
  if (titles.length) {
    const stage2 = await runKeyed(env, {
      jobs: call('list_jobs', { filters: { search: titles }, limit: LIST }),
      jobStats: call('get_job_stats', { rankBy: 'applications', filters: { search: titles }, limit: LIST }),
    });
    Object.assign(sections, statusMap(stage2.keys, stage2.outs));
    jobFacts = joinJobFacts(okResult(stage2.by.jobs)?.jobs || [], okResult(stage2.by.jobStats)?.jobs || []);
  }

  const items = [];
  for (const a of apps) {
    if (bookedApps.has(a.id) || bookedNames.has(normName(a.applicant))) continue;
    const age = daysBetween(a.appliedAt, env.now);
    let score = Math.min(age ?? 0, 30);
    const reasons = [`applied ${age ?? 'unknown'} day(s) ago`];
    const f = jobFacts.get(normName(a.job));
    if (f === null) reasons.push('several jobs share this title — deadline / openings not used');
    else if (!f) reasons.push('job deadline / openings not checked');
    else {
      const until = f.applicationDeadline ? daysBetween(env.now, f.applicationDeadline) : null;
      if (until != null && until >= 0 && until <= 7) { score += 20; reasons.push(`job deadline in ${until} day(s)`); }
      else if (until != null && until < 0) reasons.push('job deadline has passed');
      if (f.vacanciesLeft > 0) { score += 10; reasons.push(`${f.vacanciesLeft} opening(s) left`); }
      else if (f.vacanciesLeft === 0) { score -= 50; reasons.push('every opening is filled'); }
    }
    if (a.status === 'Shortlisted') { score += 5; reasons.push('Shortlisted'); }
    items.push(item(a.applicant, score, reasons, {
      job: a.job ?? null, status: a.status ?? null, appliedAt: a.appliedAt ?? null,
      applicationDeadline: f?.applicationDeadline ?? null, vacanciesLeft: f?.vacanciesLeft ?? null,
    }));
  }
  const cut = ['screening', 'shortlisted'].filter((k) => truncated(okResult(by[k])));
  if (cut.length) notes.push(`Only the first ${LIST} ${cut.join(' / ')} applications were ranked.`);
  return { rules, items, sections, notes };
}

/** normalised title → { applicationDeadline, vacanciesLeft }, or null when two visible jobs share the title. */
export function joinJobFacts(jobs, statRows) {
  const counts = nameCounts(jobs, 'title');
  const stats = new Map(statRows.map((s) => [String(s.jobId), s]));
  const out = new Map();
  for (const j of jobs) {
    const key = normName(j.title);
    if (!key) continue;
    if (counts.get(key) > 1) { out.set(key, null); continue; }
    out.set(key, { applicationDeadline: j.applicationDeadline ?? null, vacanciesLeft: stats.get(String(j.jobId))?.vacanciesLeft ?? null });
  }
  return out;
}

// ── allocate_to_project ───────────────────────────────────────────────────────
const DETAIL_CHECKS = 5;

function trainingSummary(out) {
  const s = sectionStatus(out);
  if (s.status === 'restricted') return { status: 'restricted' };
  if (s.status !== 'ok') return { status: s.status };
  const r = out.result;
  if (r.noStudentProfile) return { status: 'noProfile' };
  if (r.matches) return { status: 'ambiguous' };
  const courses = r.courses || [];
  const open = courses.filter((c) => c.status === 'enrolled' || c.status === 'in-progress');
  return {
    status: 'ok',
    total: r.total ?? courses.length,
    incomplete: open.length,
    complete: courses.length > 0 && open.length === 0,
    openCourses: open.slice(0, SECTION_ROWS).map((c) => ({ module: c.module ?? null, percentage: c.percentage ?? null })),
  };
}

async function allocateToProject({ project, designation }, env) {
  const rules = [
    'Only people under the 2-active-project limit (services/projectCapacity.js).',
    'Score = 40 on no active project / 20 on one + (20 − open tasks, min 0) + 20 when every enrolled course is complete.',
    ...(designation ? [`Designation filter: ${designation}.`] : []),
    `The top ${DETAIL_CHECKS} are checked with can_assign (the project-limit rule for this project) and their training.`,
    `Project skill needs are not captured in DharwinOne, so there is no skill match.`,
  ];
  const s1 = await runKeyed(env, {
    project: call('list_projects', { filters: { search: project }, limit: 5 }),
    zero: call('get_allocation', { mode: 'list', bucket: 'projects_0', limit: LIST, ...(designation ? { designation } : {}) }),
    one: call('get_allocation', { mode: 'list', bucket: 'projects_1', limit: LIST, ...(designation ? { designation } : {}) }),
  });
  const sections = statusMap(s1.keys, s1.outs);
  const proj = okResult(s1.by.project);
  if (proj) {
    const recs = proj.records || [];
    const exact = recs.filter((p) => normName(p.name) === normName(project));
    const pool = exact.length ? exact : recs;
    if (!pool.length) return { rules, items: [], sections, notFound: 'project', searchedFor: project };
    if (pool.length > 1) return { rules, items: [], sections, ambiguous: 'project', matches: pool.map((p) => p.name) };
    project = pool[0].name;
  }
  const people = [...(okResult(s1.by.zero)?.records || []), ...(okResult(s1.by.one)?.records || [])];
  const dup = nameCounts(people);
  const scored = people.map((p) => {
    let score = p.activeProjects === 0 ? 40 : 20;
    const reasons = [`${p.activeProjects} active project(s)`];
    if (p.openTasks == null) reasons.push('open tasks not visible to you');
    else { score += Math.max(0, 20 - p.openTasks); reasons.push(`${p.openTasks} open task(s)`); }
    if (designation) reasons.push(`designation ${p.designation ?? 'not set'}`);
    return item(p.name, score, reasons, { designation: p.designation ?? null, activeProjects: p.activeProjects, openTasks: p.openTasks ?? null });
  }).sort((a, b) => b.score - a.score);

  const toCheck = scored.filter((it) => dup.get(normName(it.subject)) === 1).slice(0, DETAIL_CHECKS);
  const checks = await env.runAll(toCheck.flatMap((it) => [
    call('get_allocation', { mode: 'can_assign', person: it.subject, project }),
    call('get_training_progress', { mode: 'person', person: it.subject }),
  ]));
  const excluded = [];
  toCheck.forEach((it, i) => {
    const can = checks[i * 2];
    const cs = sectionStatus(can);
    const r = okResult(can);
    if (r && r.eligible === false) { excluded.push({ subject: it.subject, reason: r.reason ?? 'not eligible' }); it.excluded = true; return; }
    if (r?.alreadyOnProject) { excluded.push({ subject: it.subject, reason: 'already on this project' }); it.excluded = true; return; }
    it.reasons.push(r?.eligible ? 'can_assign: allowed' : `can_assign: ${cs.status === 'ok' ? 'unknown' : cs.status}`);
    const t = trainingSummary(checks[i * 2 + 1]);
    if (t.status === 'ok' && t.complete) { it.score += 20; it.reasons.push('every enrolled course complete'); }
    else if (t.status === 'ok') it.reasons.push(t.total ? `${t.incomplete} course(s) incomplete` : 'no courses enrolled');
    else it.reasons.push(`training ${t.status === 'noProfile' ? 'not tracked (no training profile)' : t.status}`);
    it.evidence = { ...it.evidence, training: t };
    it.checked = true;
  });
  for (const it of scored) {
    if (!it.checked && !it.excluded) {
      it.reasons.push(dup.get(normName(it.subject)) > 1 ? 'shares a name with someone else — check by hand' : 'not checked in detail');
    }
  }
  const notes = [];
  if (truncated(okResult(s1.by.zero)) || truncated(okResult(s1.by.one))) notes.push(`Only the first ${LIST} people per bucket were ranked.`);
  // Reading allocation needs projects.read; assigning someone is PATCH /projects/:id (projects.manage).
  const viewerCanAssign = (await checkAccessRule({ anyOf: ['projects.manage'] }, env.user)).ok;
  if (!viewerCanAssign) notes.push('You can see this ranking but not assign people: that needs projects.manage.');
  return { rules, project, items: scored.filter((it) => !it.excluded), excluded, sections, notes, viewerCanAssign };
}

// ── training_before_assignment ────────────────────────────────────────────────
const TRAINING_CHECKS = 10;

async function trainingBeforeAssignment({ designation }, env) {
  const rules = [
    'People on no active project or one (bench first), whose enrolled courses are not all complete.',
    'Score = 20 on no project / 10 on one + 5 per incomplete course (max 30).',
    `Only the first ${TRAINING_CHECKS} people are checked; courses a position requires but nobody enrolled them in are not counted.`,
  ];
  const s1 = await runKeyed(env, {
    zero: call('get_allocation', { mode: 'list', bucket: 'projects_0', limit: LIST, ...(designation ? { designation } : {}) }),
    one: call('get_allocation', { mode: 'list', bucket: 'projects_1', limit: LIST, ...(designation ? { designation } : {}) }),
  });
  const sections = statusMap(s1.keys, s1.outs);
  const people = [...(okResult(s1.by.zero)?.records || []), ...(okResult(s1.by.one)?.records || [])];
  const dup = nameCounts(people);
  const unique = people.filter((p) => dup.get(normName(p.name)) === 1);
  const toCheck = unique.slice(0, TRAINING_CHECKS);
  const outs = await env.runAll(toCheck.map((p) => call('get_training_progress', { mode: 'person', person: p.name })));
  const items = [];
  const noTrainingProfile = [];
  const trainingNotVisible = [];
  toCheck.forEach((p, i) => {
    const t = trainingSummary(outs[i]);
    if (t.status === 'noProfile') return noTrainingProfile.push(p.name);
    if (t.status !== 'ok') return trainingNotVisible.push({ name: p.name, status: t.status });
    if (!t.incomplete) return;
    items.push(item(p.name, (p.activeProjects === 0 ? 20 : 10) + Math.min(t.incomplete * 5, 30),
      [`${p.activeProjects} active project(s)`, `${t.incomplete} course(s) incomplete`],
      { designation: p.designation ?? null, openCourses: t.openCourses }));
  });
  return {
    rules, items, sections,
    peopleUnderLimit: people.length,
    checked: toCheck.length,
    ...(noTrainingProfile.length ? { noTrainingProfile } : {}),
    ...(trainingNotVisible.length ? { trainingNotVisible } : {}),
    ...(people.length - unique.length ? { sharedNamesSkipped: people.length - unique.length } : {}),
  };
}

// ── bench_for_job ─────────────────────────────────────────────────────────────
async function benchForJob({ job }, env) {
  const rules = [
    'Employees the job-match tool ranks for this job (employees pool) who are also unallocated.',
    'Score = the match tool\'s matchPct. Unallocated falls back to "on no active project" when open tasks are not visible to you.',
  ];
  const { keys, outs, by } = await runKeyed(env, {
    match: call('match_candidates_to_job', { ...(OBJECT_ID_RE.test(job) ? { jobId: job } : { jobTitle: job }), pool: 'employees', limit: 25 }, 10000),
    unallocated: call('get_allocation', { mode: 'list', bucket: 'unallocated', limit: LIST }),
    noProject: call('get_allocation', { mode: 'list', bucket: 'projects_0', limit: LIST }),
  });
  const sections = statusMap(keys, outs);
  const notes = [];
  const m = okResult(by.match);
  if (!m) {
    const err = by.match?.status === 'ok' ? by.match.result?.error : null;
    return { rules, items: [], sections, ...(err ? { matchError: err } : {}) };
  }
  let bench = okResult(by.unallocated);
  let basis = 'unallocated';
  if (!bench || bench.total == null) {
    bench = okResult(by.noProject);
    basis = 'projects_0';
    notes.push('Used "on no active project" — full unallocated needs task visibility.');
  }
  if (!bench) return { rules, job: m.job ?? null, items: [], sections, notes };
  if (truncated(bench)) notes.push(`Only the first ${LIST} bench people were matched.`);
  const benchCount = nameCounts(bench.records);
  const matchCount = nameCounts(m.candidates, 'name');
  const shared = [];
  const items = [];
  for (const c of m.candidates || []) {
    const key = normName(c.name);
    if (!benchCount.has(key)) continue;
    if (benchCount.get(key) > 1 || matchCount.get(key) > 1) { shared.push(c.name); continue; }
    const b = bench.records.find((r) => normName(r.name) === key);
    items.push(item(c.name, c.matchPct ?? 0, [`matchPct ${c.matchPct}`, basis === 'unallocated' ? 'unallocated' : 'on no active project'],
      { designation: b?.designation ?? null, skills: (c.skills || []).slice(0, 6) }));
  }
  if (shared.length) notes.push(`Skipped shared names (check by hand): ${shared.slice(0, SECTION_ROWS).join(', ')}.`);
  return { rules, job: m.job ?? null, basis, matchedTotal: (m.candidates || []).length, items, sections, notes };
}

// ── team_task_priorities ──────────────────────────────────────────────────────
const PRIORITY_POINTS = Object.freeze({ urgent: 30, high: 20, medium: 10, low: 0 });

async function teamTaskPriorities({ team }, env) {
  const rules = [
    'Open (not completed) tasks on the team\'s projects.',
    'Score = 100 + days overdue (max 30) when overdue; + priority (urgent 30, high 20, medium 10); + (14 − days until due, min 0).',
    'Tasks with no due date are left out.',
  ];
  const { keys, outs, by } = await runKeyed(env, {
    overdue: call('list_tasks', { filters: { teamName: team, overdue: true }, sort: 'dueDate', limit: LIST }),
    // From today on: sorted by due date with no bound, the page is the team's oldest (mostly completed) tasks.
    upcoming: call('list_tasks', { filters: { teamName: team, dueBetween: { from: todayIst(env.now) } }, sort: 'dueDate', limit: LIST }),
  });
  const sections = statusMap(keys, outs);
  const first = okResult(by.overdue) ?? okResult(by.upcoming);
  if (first?.ambiguous || first?.notFound) {
    return { rules, items: [], sections, ...(first.ambiguous ? { ambiguous: 'team', matches: first.matches } : { notFound: 'team', searchedFor: team }) };
  }
  const seen = new Map();
  for (const r of [...(okResult(by.overdue)?.records || []), ...(okResult(by.upcoming)?.records || [])]) {
    if (r.status === 'completed' || !r.dueDate || seen.has(r.id)) continue;
    seen.set(r.id, r);
  }
  const items = [...seen.values()].map((t) => {
    const until = daysBetween(env.now, t.dueDate);
    const reasons = [];
    let score = 0;
    if (until < 0) { score += 100 + Math.min(-until, 30); reasons.push(`overdue by ${-until} day(s)`); }
    score += PRIORITY_POINTS[t.priority] ?? 0;
    if (t.priority) reasons.push(`priority ${t.priority}`);
    if (until >= 0) { score += Math.max(0, 14 - until); reasons.push(`due in ${until} day(s)`); }
    return item(`${t.code ? `${t.code} ` : ''}${t.title ?? ''}`.trim(), score, reasons,
      { project: t.project ?? null, assignees: (t.assignees || []).slice(0, 3), dueDate: t.dueDate, status: t.status, blocked: t.blocked ?? null });
  });
  const notes = [];
  if (first?.scope === 'mine') notes.push('Only your own tasks — the team\'s full board needs tasks.read.');
  if (truncated(okResult(by.overdue)) || truncated(okResult(by.upcoming))) notes.push(`Only the first ${LIST} tasks per list were ranked.`);
  return { rules, team, items, sections, notes };
}

// ── recruiter_capacity ────────────────────────────────────────────────────────
const POOL_MAX = 5000;
const OVERLOAD_RATIO = 1.5;

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function recruiterCapacity(_args, env, ctx) {
  const rules = [
    'Recruiter = the job\'s assigned recruiter, else its creator (Job model); active jobs you can see.',
    'Open applications = every stage except Offered, Hired and Rejected, one per person per job (applications you can see).',
    `Score = open applications ÷ the median across recruiters × 100; at least ${OVERLOAD_RATIO}× the median is flagged.`,
    'A workload comparison only — never a judgement of anyone\'s performance.',
  ];
  if (!(await checkAccessRule(JOBS_ACCESS, env.user)).ok) return { rules, items: [], sections: { jobs: 'restricted' } };
  // ponytail: no Wave 1 tool groups jobs or applications by recruiter (get_job_stats rows carry no
  // recruiter), so this reads the Jobs page's own visibility clause + an explicit projection, and the
  // Job analytics page's scoped aggregateApplicationsByJob. Capped at POOL_MAX active jobs; past that,
  // add a recruiter group stage to aggregateApplicationsByJob instead of loading jobs here.
  const { Job, visibilityFilter } = await jobScope(ctx);
  const jobs = await Job.find(andMongoFilters({ status: 'Active' }, visibilityFilter))
    .select('title assignedRecruiter createdBy')
    .populate([{ path: 'assignedRecruiter', select: 'name' }, { path: 'createdBy', select: 'name' }])
    .limit(POOL_MAX)
    .lean();
  if (!jobs.length) return { rules, items: [], sections: { jobs: 'ok', applications: 'ok' }, activeJobs: 0 };
  const apps = await applicationsByJob({ jobIds: jobs.map((j) => String(j._id)) }, env.user, jobStatsDeps(ctx));

  const byRecruiter = new Map();
  for (const j of jobs) {
    const who = j.assignedRecruiter?._id ? j.assignedRecruiter : j.createdBy;
    const key = who?._id ? String(who._id) : 'unknown';
    const row = byRecruiter.get(key) || { name: who?.name ?? null, jobs: 0, open: 0, atInterview: 0, interviewed: 0 };
    const a = apps.get(String(j._id));
    row.jobs += 1;
    if (a) {
      for (const [stage, n] of Object.entries(a.byStage || {})) {
        if (!CLOSED_APPLICATION_STATUSES.includes(stage)) row.open += n;
      }
      row.atInterview += a.byStage?.Interview || 0;
      row.interviewed += a.interviewed || 0;
    }
    byRecruiter.set(key, row);
  }
  const rows = [...byRecruiter.values()];
  const med = median(rows.map((r) => r.open));
  const items = rows.map((r) => {
    const ratio = med > 0 ? r.open / med : null;
    const reasons = [`${r.open} open application(s) across ${r.jobs} active job(s)`, `median ${med}`];
    if (ratio != null && ratio >= OVERLOAD_RATIO) reasons.push(`at least ${OVERLOAD_RATIO}× the median`);
    return item(r.name ?? 'Recruiter name not captured', ratio == null ? 0 : Math.round(ratio * 100), reasons,
      { activeJobs: r.jobs, openApplications: r.open, atInterviewStage: r.atInterview, interviewed: r.interviewed });
  });
  const flagged = items.filter((i) => i.reasons.some((x) => x.startsWith('at least'))).map((i) => i.subject);
  return {
    rules,
    items,
    sections: { jobs: 'ok', applications: 'ok' },
    medianOpen: med,
    recruiters: rows.length,
    activeJobs: jobs.length,
    ...(jobs.length === POOL_MAX ? { poolNote: `Only the first ${POOL_MAX} active jobs were counted.` } : {}),
    ...(flagged.length ? { suggestion: `Workload is heaviest for ${flagged.slice(0, SECTION_ROWS).join(', ')} — another recruiter on their jobs would even it out.` } : {}),
  };
}

export const KINDS = Object.freeze({
  follow_ups_today: { run: followUpsToday },
  next_candidate_to_contact: { run: nextCandidateToContact },
  interview_order: { run: interviewOrder },
  allocate_to_project: { run: allocateToProject, needs: 'project' },
  training_before_assignment: { run: trainingBeforeAssignment },
  bench_for_job: { run: benchForJob, needs: 'job' },
  team_task_priorities: { run: teamTaskPriorities, needs: 'team' },
  recruiter_capacity: { run: recruiterCapacity },
});
