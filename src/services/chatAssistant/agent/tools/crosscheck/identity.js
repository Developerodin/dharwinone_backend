import { OBJECT_ID_RE, idOf, okSet } from './common.js';
import { ownsProfile } from '../ownsProfile.js';

/*
 * Id kinds the sets use, and the reference field each hop reads:
 *
 *  employee → user   Employee.owner. JobApplication.candidate, Offer.candidate, Placement.candidate and
 *                    Meeting.candidate.id are Employee ids. Public-apply candidate profiles can be owned by
 *                    the job creator (applicantQuery.service), so when an owner has more than one profile
 *                    a profile maps only if its email equals the owner's login email; otherwise unmapped.
 *  student  → user   Student.user. Attendance, LeaveRequest.student and the Training Evaluation rows'
 *                    studentId are Student ids.
 *  email    → user   User.email, else Employee.companyAssignedEmail / Employee.email → owner — the addresses
 *                    visibilityScope resolveActorEmails matches meeting hosts and invitees on.
 *  code     → user   Employee.employeeId (e.g. DBS10) → owner; the attendance summary rows carry it.
 *  Task.assignedTo, Project.assignedTo, Meeting.recruiter.id / agents.id and InternalMeeting.createdBy are
 *  already User ids.
 *
 * Every mapper returns { map: Map<fromId, userId>, unmapped: string[] }. An id that cannot be mapped is
 * returned in `unmapped` and counted in the answer, never dropped silently.
 */

const lc = (s) => String(s ?? '').trim().toLowerCase();
const uniq = (xs) => [...new Set(xs.filter(Boolean).map(String))];

export async function employeesToUsers(ids, deps) {
  const wanted = uniq(ids);
  const valid = wanted.filter((id) => OBJECT_ID_RE.test(id));
  const emps = valid.length
    ? await deps.Employee.find({ _id: { $in: valid } }).select('owner email').lean()
    : [];
  const owns = await ownsProfile(emps, deps);
  const map = new Map();
  for (const e of emps) if (owns(e)) map.set(idOf(e), idOf(e.owner));
  return { map, unmapped: wanted.filter((id) => !map.has(id)) };
}

export async function studentsToUsers(ids, deps) {
  const wanted = uniq(ids);
  const valid = wanted.filter((id) => OBJECT_ID_RE.test(id));
  const rows = valid.length ? await deps.Student.find({ _id: { $in: valid } }).select('user').lean() : [];
  const map = new Map();
  for (const s of rows) if (s.user) map.set(idOf(s), idOf(s.user));
  return { map, unmapped: wanted.filter((id) => !map.has(id)) };
}

/** Keys of the returned map are lower-cased emails. */
export async function emailsToUsers(emails, deps) {
  const wanted = uniq(emails.map(lc));
  if (!wanted.length) return { map: new Map(), unmapped: [] };
  const users = await deps.User.find({ email: { $in: wanted } }).select('email').lean();
  const map = new Map(users.map((u) => [lc(u.email), idOf(u)]));
  const rest = wanted.filter((e) => !map.has(e));
  if (rest.length) {
    const emps = await deps.Employee.find({ $or: [{ companyAssignedEmail: { $in: rest } }, { email: { $in: rest } }] })
      .select('owner email companyAssignedEmail').lean();
    const owns = await ownsProfile(emps, deps);
    for (const e of emps) {
      if (!owns(e)) continue;
      for (const addr of [lc(e.companyAssignedEmail), lc(e.email)]) {
        if (rest.includes(addr) && !map.has(addr)) map.set(addr, idOf(e.owner));
      }
    }
  }
  return { map, unmapped: wanted.filter((e) => !map.has(e)) };
}

export async function employeeCodesToUsers(codes, deps) {
  const wanted = uniq(codes);
  if (!wanted.length) return { map: new Map(), unmapped: [] };
  const emps = await deps.Employee.find({ employeeId: { $in: wanted } }).select('employeeId owner').lean();
  const map = new Map();
  for (const e of emps) if (e.owner && !map.has(e.employeeId)) map.set(String(e.employeeId), idOf(e.owner));
  return { map, unmapped: wanted.filter((c) => !map.has(c)) };
}

/**
 * Re-key an ok set through a mapper result. Two source ids landing on one user merge their info
 * (`merge` decides how); unmapped source ids add to the set's unmapped count.
 */
export function mapSet(set, { map, unmapped }, kind, merge = (a) => a) {
  if (set.status !== 'ok') return set;
  const info = new Map();
  for (const [from, value] of set.info) {
    const to = map.get(from);
    if (!to) continue;
    info.set(to, info.has(to) ? merge(info.get(to), value) : value);
  }
  return okSet(set.label, kind, info, {
    truncated: set.truncated,
    unmapped: set.unmapped + unmapped.filter((id) => set.info.has(id)).length,
    partialScope: set.partialScope,
    notes: set.notes,
  });
}

// ─── Names for result rows (only the ≤ limit rows an answer shows) ──────────

/** User ids → { name, employeeId, employeeProfile }. A login with no Employee profile keeps its User name. */
export async function namesForUsers(ids, deps) {
  const wanted = uniq(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!wanted.length) return new Map();
  const [emps, users] = await Promise.all([
    deps.Employee.find({ owner: { $in: wanted } }).select('owner fullName employeeId email').lean(),
    deps.User.find({ _id: { $in: wanted } }).select('name').lean(),
  ]);
  const out = new Map(users.map((u) => [idOf(u), { name: u.name ?? null, employeeId: null, employeeProfile: false }]));
  const owns = await ownsProfile(emps, deps);
  for (const e of emps) {
    const owner = idOf(e.owner);
    if (!owns(e) || out.get(owner)?.employeeProfile) continue;
    out.set(owner, { name: e.fullName ?? out.get(owner)?.name ?? null, employeeId: e.employeeId ?? null, employeeProfile: true });
  }
  return out;
}

export async function namesForEmployees(ids, deps) {
  const wanted = uniq(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!wanted.length) return new Map();
  const emps = await deps.Employee.find({ _id: { $in: wanted } }).select('fullName employeeId').lean();
  return new Map(emps.map((e) => [idOf(e), { name: e.fullName ?? null, employeeId: e.employeeId ?? null }]));
}

export async function namesForApplications(ids, deps) {
  const wanted = uniq(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!wanted.length) return new Map();
  const apps = await deps.JobApplication.find({ _id: { $in: wanted } }).select('candidate job')
    .populate('candidate', 'fullName employeeId').populate('job', 'title').lean();
  return new Map(apps.map((a) => [idOf(a), {
    name: a.candidate?.fullName ?? null,
    employeeId: a.candidate?.employeeId ?? null,
    job: a.job?.title ?? null,
  }]));
}

export const NAMES_BY_KIND = {
  user: namesForUsers,
  employee: namesForEmployees,
  application: namesForApplications,
};
