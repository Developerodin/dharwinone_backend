const idOf = (v) => (v == null ? null : String(v?._id ?? v));
const lc = (s) => String(s ?? '').trim().toLowerCase();

/**
 * `(employee) => bool`: does this Employee profile speak for its owner login? Yes when it is the owner's only
 * profile, or its email equals the owner's login email. Public-apply candidate profiles are owned by the job
 * creator (job.service.js), so a recruiter owning many candidate profiles is neither — Employee.owner alone
 * would pass the recruiter off as the candidate. `emps` need `owner` and `email`; deps: { Employee, User }.
 */
export async function ownsProfile(emps, deps) {
  const owners = [...new Set(emps.map((e) => idOf(e.owner)).filter(Boolean))];
  const profiles = owners.length
    ? await deps.Employee.find({ owner: { $in: owners } }).select('owner').lean()
    : [];
  const perOwner = new Map();
  for (const p of profiles) perOwner.set(idOf(p.owner), (perOwner.get(idOf(p.owner)) ?? 0) + 1);
  const shared = new Set(owners.filter((o) => (perOwner.get(o) ?? 1) > 1));
  const ownerEmail = new Map();
  if (shared.size) {
    const users = await deps.User.find({ _id: { $in: [...shared] } }).select('email').lean();
    for (const u of users) ownerEmail.set(idOf(u), lc(u.email));
  }
  return (e) => {
    const owner = idOf(e.owner);
    if (!owner) return false;
    return !shared.has(owner) || (!!e.email && lc(e.email) === ownerEmail.get(owner));
  };
}
