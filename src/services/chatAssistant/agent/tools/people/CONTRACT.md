# People domain contract — users + roles tools

Covers `count_users`, `list_users`, `get_user` (task-3-brief.md) and `list_roles`,
`get_role` (task-4-brief.md). This document is the spec; task 3/4 implement it
verbatim. Deviating from a ruling here needs a new ruling recorded in this file,
not a silent choice in the implementation PR.

Domain name for all five tools: `'people'`. One `agent/tools/people/index.js`
exports `{ domain: 'people', instructions, tools: [countUsers, listUsers, getUser,
listRoles, getRole] }`.

Suggested file layout (mirrors `agent/tools/jobs/`):
```
agent/tools/people/
  common.js        // peopleScope(ctx), role-name resolver, ObjectId regex, adminIdOf()
  filters.js        // the `filters` Joi object + withDefaultStatus() for count_users/list_users
  countUsers.tool.js
  listUsers.tool.js
  getUser.tool.js
  listRoles.tool.js
  getRole.tool.js
  index.js
```

---

## 0. Verified facts that shape this contract

- **`buildUserListMongoFilter(filter, requester)`** (`user.service.js`) destructures
  `search, role, names, domains, education, locations, email` out of `filter` and
  spreads the rest (`...restFilter`) straight into the Mongo filter. `role` is
  consumed **only** by `applyRoleScope`, which recognizes exactly three literal
  values (`recruiter`, `referral_eligible`, `sales_agent`) and is a no-op for
  anything else — it does **not** throw or fall through to a generic name lookup.
  `status` is **not** destructured, so whatever the caller puts in `filter.status`
  (or nothing) flows straight through unfiltered.
- **Hidden-user exclusion is real but partial.** `applyHiddenUserFilter` excludes
  `hideFromDirectory: true` users unless `viewerSeesHiddenUsers(requester)` (i.e.
  `requester.platformSuperUser`). It does **not** exclude `platformSuperUser`
  accounts — `getDirectoryHiddenUserIds()` only queries `{ hideFromDirectory: true }`.
  So today, `buildUserListMongoFilter` alone would let a platform-super seed
  account count as a regular user. Contrast with `role.service.js`'s
  `getAssigneeCountsByRoleId`, used by the existing Settings → Roles page, which
  explicitly does `{ platformSuperUser: { $ne: true } }`. **Ruling R1** below
  closes this gap for the new tools.
- **`status: 'deleted'`** is not excluded by anything in `buildUserListMongoFilter`.
  Exclusion is entirely a function of whatever default the tool layer applies
  (Ruling R2 covers the status default).
- **`roleRegistry.js`'s cache (`loadRoleRegistry`) only indexes `status: 'active'`
  roles**, TTL 60s. `tagRoleSlugs`/`tagRoleDisplayNames`/`resolveRoleSync` all read
  this cache and therefore silently omit **inactive** roles. `resolvePersonProfile`
  depends on this cache for `identity.roles`/`roleSlugs` and for selecting which
  personProfile providers run (`selectProviders(roleSlugs)`); a user whose only
  role is inactive gets `kind: 'unavailable'` from `resolvePersonProfile`, and a
  user holding one active + one inactive role will simply never show the inactive
  one in `identity.roles`/`profiles`. This is pre-existing behavior shared with the
  legacy `resolve_person_profile` tool — not something this contract changes (see
  Open risk OR1).
- **`personProfile/providers/userScalar.js`'s `load()` and `resolvePersonProfile`'s
  own `loadUserById` (the `userId`-path loader) do not check `hideFromDirectory`
  or `platformSuperUser` at all.** Only the free-text `person`-path
  (`entityResolver.resolveUserEntity`) applies that suppression. This is a real
  gap for `get_user({ id })` — closed by Ruling R6.
- **`toJsonSchema.js` supports `array` items only with `.max()`, never `.min()`**
  (`ARRAY_RULES = ['max']`) — confirmed by reading the converter directly. Any
  `role`/multi-value filter must use `.max()` only.
- **`.custom()` Joi rules are unsupported** by the converter (not in the
  `object|string|number|boolean|array|alternatives` switch) — so `boundedLimit()`
  (used by `getUsers.query.limit`) cannot be reused via `.extract()`. Every tool
  writes its own `limit` locally, same as `list_jobs`.
- **`toolRegistry.js`'s automatic `guardResultForRule(tool.access, result, user)`**
  runs after every `execute()` regardless of what the tool returns. Its
  `rowScope: 'person'` branch (`applyRowScope`) only recognizes three result
  shapes: a bare array, `{ records: [...] }`, `{ candidates: [...] }` — for any
  other shape it returns the result **unchanged** (falls through to `return result`
  at the end of `applyRowScope`). `get_user`'s result is none of those shapes, so
  setting `rowScope: 'person'` on it gets **zero** automatic row filtering — only
  the `redactSalary` half of that same guard (`stripKey(result, 'salaryRange')`,
  which recurses through any object/array shape) actually does something. See
  Ruling R7.
- **`GET /users` and `GET /users/:userId`** are both gated
  `requireAnyOfPermissions('users.read', 'recruiters.read')`. `users.read`'s alias
  list in `config/permissions.js` already includes `recruiters.read` (and its
  `ats.recruiters:*` variants), so `checkAccessRule({ anyOf: ['users.read'] }, ...)`
  is exactly equivalent to that route gate — confirmed, not assumed.
- **`GET /roles`** is gated `requirePermissions('roles.read')` only (no alias, no
  `.manage` fallback) — matches `TOOL_ACCESS.fetch_roles` exactly, and
  `permissionAliases` has no `roles.read` entry (falls back to `['roles.read']`).
- **Neither the Users directory (`GET /users`) nor the Roles page has Employee-page-style
  row/ownership scoping.** `resolveRowScope`/`applyEmployeeListScope` scope the
  *Employees/Candidates* population (Agent → assignedAgent, Sales Agent →
  referred/currentSalesAgent). `count_users`/`list_users` read the User directory,
  which every `users.read`/`recruiters.read` holder sees in full (minus hidden/
  platform-super) — there is no per-row ownership gate on that page today. Row
  scope only matters for `get_user`, because it additionally surfaces
  Employee/Candidate *profile* data (Ruling R8).

---

## 1. Shared plumbing — `people/common.js`

```js
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/** Fail-closed guard, mirrors jobs' jobScope(ctx). */
export function peopleScope(ctx) {
  if (!ctx?.user?.id && !ctx?.user?._id) {
    throw new Error('people tools need an authenticated user with an id');
  }
  return ctx.user;
}

export const PEOPLE_ACCESS = Object.freeze({ anyOf: ['users.read'] });          // count_users, list_users
export const PEOPLE_PROFILE_ACCESS = Object.freeze({ anyOf: ['users.read'], rowScope: 'person' }); // get_user
export const ROLES_ACCESS = Object.freeze({ anyOf: ['roles.read'] });           // list_roles, get_role

/** Unconditional — mirrors role.service.js's getAssigneeCountsByRoleId. Ruling R1. */
export const EXCLUDE_PLATFORM_SUPER = { platformSuperUser: { $ne: true } };

/** adminId convention used throughout chatAssistant.service.js. */
export const adminIdOf = (user) => user.adminId ?? user.id ?? user._id;

/**
 * Resolve free-form role name(s) to Role _ids by direct Role-collection lookup —
 * NOT roleRegistry (see fact above: registry is active-only + 60s cached; a role
 * filter must still match an inactive role that still has assigned users, and
 * must not depend on cache warm state for a deterministic tool call).
 * Exact, case-insensitive match only, against: name, slug (slugifyRole(input)
 * compared to stored slug), any alias, any previousNames[].name. No partial/
 * substring matching — a headcount tool must not silently guess.
 * @param {string[]} names
 * @returns {Promise<{ ids: string[], unknown: string[], allRoleNames: string[] }>}
 */
export async function resolveRoleNames(names, { Role = RoleModel } = {}) {
  const all = await Role.find(
    {},
    { name: 1, slug: 1, aliases: 1, previousNames: 1, status: 1 }
  ).lean(); // all statuses — see rationale above
  const ids = new Set();
  const unknown = [];
  for (const raw of names) {
    const wanted = String(raw).trim().toLowerCase();
    const wantedSlug = slugifyRole(raw);
    const hit = all.filter((r) =>
      String(r.name).toLowerCase() === wanted ||
      r.slug === wantedSlug ||
      (r.aliases || []).some((a) => String(a).toLowerCase() === wanted) ||
      (r.previousNames || []).some((p) => String(p.name).toLowerCase() === wanted)
    );
    if (!hit.length) unknown.push(raw);
    else hit.forEach((r) => ids.add(String(r._id)));
  }
  return { ids: [...ids], unknown, allRoleNames: all.map((r) => r.name) };
}

/**
 * Batch roleIds -> display names via a direct Role query (not roleRegistry, same
 * inactive-role reason as resolveRoleNames). Used by list_users rows and
 * count_users groupBy:'role' labels.
 */
export async function roleNamesForIds(roleIds, { Role = RoleModel } = {}) {
  const uniq = [...new Set((roleIds || []).map(String))];
  if (!uniq.length) return new Map();
  const docs = await Role.find({ _id: { $in: uniq } }, { name: 1 }).lean();
  return new Map(docs.map((d) => [String(d._id), d.name]));
}
```

**Ruling R1 — exclude `platformSuperUser` unconditionally, in every user-count
surface this contract touches.** `buildUserListMongoFilter` does not;
`role.service.js`'s existing per-role counts already do, specifically so the
seed/owner account doesn't inflate the Settings → Roles page. `count_users`,
`list_users`, and `list_roles`'s `userCount` must all apply
`EXCLUDE_PLATFORM_SUPER` themselves — not rely on `buildUserListMongoFilter`,
which silently doesn't do this. Applied regardless of viewer (not
viewer-conditional, unlike hidden-user suppression) — a platform-super viewer
asking "how many users" still shouldn't get the seed account counted as a
person.

---

## 2. `filters.js` — shared `filters` object for `count_users` / `list_users`

```js
import Joi from 'joi';

export const filters = Joi.object({
  search: Joi.string().min(1)
    .description('Matches name or email — like the Users directory search box.'),
  status: Joi.string().valid('active', 'pending', 'disabled', 'deleted', 'all')
    .description(
      'Defaults to active. Pass "all" only when the user asks for every status ' +
      '(e.g. "including disabled", "every account").'
    ),
  role: Joi.alternatives()
    .try(Joi.string().min(1), Joi.array().items(Joi.string().min(1)).max(10))
    .description(
      'Any role name in the system (e.g. "Administrator", "Sales Agent", ' +
      '"Recruiter") — not limited to a fixed list. Pass an array to match ANY of ' +
      'several roles. An unrecognized name is an error, not a silent empty result.'
    ),
  location: Joi.string().min(1).description('Filter by location (partial match).'),
  domain: Joi.string().min(1).description('Filter by domain/specialization (partial match).'),
  education: Joi.string().min(1).description('Filter by education (partial match).'),
}).description('User filters. Omit a key to leave it unfiltered; status defaults to active.');

/**
 * Same idiom as jobs' withDefaultStatus: status defaults to 'active', except a
 * breakdown BY status defaults to unfiltered ('all') so it isn't collapsed to
 * one bucket.
 */
export function withDefaultStatus(f = {}, { groupBy } = {}) {
  if (f.status) return { ...f };
  return { ...f, status: groupBy === 'status' ? 'all' : 'active' };
}
```

**Ruling R2 — role filter resolves ANY role name, not the page's 3-value enum.**
This is the decision the brief names explicitly. `getUsers.query.role` (the REST
`GET /users` filter) only recognizes `recruiter | referral_eligible | sales_agent`
— a fixed picker enum for three specific UI use cases (interview/kanban assignee
pickers). That enum cannot answer "how many admins" or "who has role X" for an
arbitrary role, which is exactly `count_users`'/`list_users`' stated purpose
(task-3-brief's `matchesTurn` examples). So: `filters.role` accepts free-form
name(s), resolved via `resolveRoleNames()` (§1) against the live Role collection
— name, slug, alias, or previousName, case-insensitive exact match, any status.
An input name matching zero roles is a **tool error** (throw, so the model sees
it and can retry or say so) that lists the valid role names
(`resolveRoleNames`'s `allRoleNames`), not a silent 0-result filter.

**Ruling R3 — `filters.role` bypasses `buildUserListMongoFilter`'s own `role`
key entirely.** The tool never sets `filter.role` when calling
`buildUserListMongoFilter`; it resolves role name(s) to ids itself and adds
`filter.roleIds = { $in: ids }` instead — `roleIds` is not one of
`buildUserListMongoFilter`'s destructured keys, so it flows straight through
via `...restFilter` unchanged. This avoids colliding with (or being silently
ignored by) `applyRoleScope`'s 3-enum-only logic.

**Ruling R4 — `location`/`domain`/`education` are singular Sage-facing keys that
map to `buildUserListMongoFilter`'s plural, list-based facet keys.** The service
filter takes `locations`/`domains`/`education` (via `applyUserFacetFilters`,
which OR's a list of partial-match regexes). The tool passes
`{ locations: [filters.location], domains: [filters.domain], education: [filters.education] }`
(single-element arrays — `buildUserListMongoFilter`'s `parseStringList` accepts
either a string or an array, so a bare string also works; use whichever reads
cleaner in the implementation, behavior is identical). `search` maps 1:1, same key
name both sides.

**Ruling R5 — the `'all'` status value is a Sage-only sentinel, stripped before
querying, never sent to `buildUserListMongoFilter` as a literal string.**
`buildUserListMongoFilter` has no `'all'` convention of its own — passing
`status: 'all'` literally would filter for `User.status === 'all'` (zero
matches). The tool must:
```js
const filtersApplied = withDefaultStatus(rawFilters, { groupBy });
const { status, ...rest } = filtersApplied;
const svcFilter = { ...rest, ...(status !== 'all' ? { status } : {}) };
const mongoFilter = { ...(await buildUserListMongoFilter(svcFilter, ctx.user)), ...EXCLUDE_PLATFORM_SUPER };
if (roleIds.length) mongoFilter.roleIds = { $in: roleIds };
```
(`buildUserListMongoFilter` is `async` — it awaits `applyRoleScope` and
`applyHiddenUserFilter`.)

---

## 3. `count_users`

```js
input: Joi.object({
  filters,
  groupBy: Joi.string().valid('role', 'status')
    .description(
      'Break the count down by this field. groupBy:role counts a user once per ' +
      'role they hold (a user with 2 roles is counted in both groups — say so). ' +
      'A user with NO role is excluded from every group (unlike the ungrouped total).'
    ),
})
```
- **Access:** `PEOPLE_ACCESS` (`anyOf: ['users.read']`) — confirmed equivalent to
  `GET /users`'s `requireAnyOfPermissions('users.read', 'recruiters.read')` (§0).
- **Service call:** `buildUserListMongoFilter` + `User.countDocuments` /
  `User.aggregate`, per Ruling R5's `mongoFilter` construction. No `queryUsers`
  (avoids its `companyAssignedEmail` Employee-join enrichment, irrelevant to a
  count and unnecessary I/O).
- **No `groupBy`:** `{ total: await User.countDocuments(mongoFilter), filtersApplied }`.
- **`groupBy: 'status'`:** `User.aggregate([{ $match: mongoFilter }, { $group: { _id: '$status', count: { $sum: 1 } } }])`.
  Because `withDefaultStatus` defaults `status` to `'all'` (i.e. omitted) when
  `groupBy === 'status'`, this naturally covers every status present (labels come
  straight from the DB values: active/pending/disabled/deleted).
- **`groupBy: 'role'`:** `User.aggregate([{ $match: mongoFilter }, { $unwind: '$roleIds' }, { $group: { _id: '$roleIds', count: { $sum: 1 } } }])`,
  then map `_id` → name via `roleNamesForIds()` (§1). `$unwind` drops users with
  an empty `roleIds` array — they are silently excluded from every group (see the
  input description above; the domain `instructions` string must repeat this so
  the model doesn't claim group totals sum to the ungrouped total).
- Group shaping: same idiom as `count_jobs` — sort desc by count, cap at 25 groups
  (`MAX_GROUPS`), roll the rest into `otherCount`. No `Not set` bucket needed for
  `groupBy:'status'` (status is never null); `groupBy:'role'` has no null bucket
  either since `$unwind` already dropped those rows.
- **Render:** ungrouped → `facts.counts: [{ kind: 'count_users', label: 'users', total }]`.
  Grouped → a table block (columns: group value | count), **no** count facts
  (same reasoning as `count_jobs`: rewriting every group's number to the overall
  total would corrupt the breakdown).

---

## 4. `list_users`

```js
input: Joi.object({
  filters,
  limit: Joi.number().integer().min(1).max(25).default(10)
    .description('Max rows to return (default 10, max 25). total is always the full count.'),
})
```
- **Access:** `PEOPLE_ACCESS`.
- **Service call:** same `mongoFilter` construction as `count_users` (Ruling R5,
  no `groupBy`). `User.find(mongoFilter).select('name email status roleIds lastLoginAt').sort('-createdAt').limit(limit).lean()`
  + `User.countDocuments(mongoFilter)` for `total`. `.lean()` is safe here
  precisely because the tool selects and maps fields explicitly (row shape
  below) — it never spreads the raw lean doc into the result, so `password`/
  `failedLoginCount`/`loginLockedUntil` (schema `private: true`) never reach the
  envelope even though `.lean()` bypasses the `toJSON` transform that would
  otherwise strip them.
- **Row shape:** `{ id, name, email, roles: [name, ...], status, lastLoginAt }`.
  `roles` resolved via one batched `roleNamesForIds()` call (§1) over the
  page's distinct `roleIds`, not per-row queries.
- **Return:** `{ total, users: [...rows], filtersApplied }` (mirrors `list_jobs`'
  `{ total, jobs, filtersApplied }` shape; key name `users` not `jobs`/`records` —
  deliberately **not** `records`, since that name would make the registry's
  automatic `applyRowScope` (rowScope:'person') try to row-filter it by Employee
  ownership, which is wrong for a Users-directory listing (§0's row-scope fact).
  `list_users` does not set `rowScope: 'person'` at all — see Ruling R8.
- **Render:** a table block (Name | Email | Roles | Status | Last login) +
  `facts.counts: [{ kind: 'list_users', label: 'users', total }]` (matches
  `list_jobs`'s pattern: `total` is always the full filtered count, independent
  of how many rows were returned).

---

## 5. `get_user`

```js
input: Joi.object({
  id: Joi.string().description('User id (id/userId from an earlier list_users row).'),
  name: Joi.string().min(1).description('Person\'s name, email, or part of it.'),
}).or('id', 'name')
```
(`.or()` at the object level is already precedented by `get_job.tool.js` —
`toJsonSchema`'s `convertObject` doesn't inspect `desc.nand`/`desc.or`, so it's
silently omitted from the JSON Schema the model sees; Joi still enforces it at
validation time in `toolRegistry.execute`.)

- **Access:** `PEOPLE_PROFILE_ACCESS` (`{ anyOf: ['users.read'], rowScope: 'person' }`).

**Ruling R6 — the `id` path must go through `getUserByIdForRequester` before
calling `resolvePersonProfile`; it must not pass `userId` straight through.**
`resolvePersonProfile`'s `userId`-path loader (`realLoadUserById` /
`makeUserScalarProvider`'s `load`) is an unconditional `User.findById(...).lean()`
— it does not check `hideFromDirectory` or `platformSuperUser` the way the
`person`-path (`resolveUserEntity`) does. That means `get_user({ id })` on a
directory-hidden or platform-super target's id would currently leak a full
profile that `get_user({ name: "..." })` for the same person would correctly
refuse. Fix, mirroring what `GET /users/:userId` already does via
`getUserByIdForRequester`:
```js
async execute({ id, name } = {}, ctx) {
  const user = peopleScope(ctx);
  const adminId = adminIdOf(user);

  let targetId = null;
  if (id) {
    if (!OBJECT_ID_RE.test(id)) return { matches: [] };
    try {
      await getUserByIdForRequester(id, user); // throws NOT_FOUND if missing, or hidden/platform-super and viewer isn't self/platform-super
    } catch {
      return { matches: [] };
    }
    targetId = id;
  }

  const profile = await resolvePersonProfile({
    ...(targetId ? { userId: targetId } : { person: name }),
    depth: 'full',
    viewer: user,
    impersonating: !!user.__impersonating,
    adminId,
    deps: ctx.deps,
  });

  if (profile.kind === 'ambiguous') return { matches: profile.matches };
  if (profile.kind === 'notFound') return { matches: [] };
  if (profile.kind === 'notAuthorized') return { error: 'not_authorized' };
  if (profile.kind === 'unavailable') return { error: 'unavailable' };

  // profile.kind === 'unique' — enrich with full role definitions, then row-scope.
  const row = await User.findById(profile.identity.userId).select('roleIds').lean();
  const roleDocs = await Role.find({ _id: { $in: row?.roleIds || [] } })
    .select('name slug aliases status permissions').lean();
  const roles = roleDocs.map(({ name, slug, aliases, status, permissions }) => ({ name, slug, aliases, status, permissions }));

  let profiles = profile.profiles;
  const allowedOwners = await resolveRowScope(user);
  if (allowedOwners && !allowedOwners.has(String(profile.identity.userId))) {
    const { employee, candidate, ...rest } = profiles;
    profiles = rest;
  }

  return { kind: 'unique', identity: profile.identity, roles, profiles, availableSections: profile.availableSections };
}
```
- **`profile.identity.userId`, not `row.roleIds`, drives which Role docs get
  fetched for `roles[]` — deliberately NOT `identity.roleSlugs`/`identity.roles`**
  (those come from `tagRoleDisplayNames`/`tagRoleSlugs`, which — per §0's fact —
  silently drop inactive roles). `roles[]` is a **fresh, direct** `User.roleIds` →
  `Role.find` lookup precisely so it reflects every role the user holds,
  active or not, matching the brief's "every role the user holds." This does
  create a documented asymmetry: `roles[]` may list an inactive role that has no
  corresponding entry in `profiles` (since `resolvePersonProfile`'s provider
  selection is itself active-role-gated) — see Open risk OR1.

**Ruling R7 — `rowScope: 'person'` is set on `get_user`'s access for the free
`redactSalary` pass, but the Employees/Candidates row-scope check must be
implemented by hand in `execute()` (above), not left to the registry.** Per §0,
`applyRowScope` only recognizes bare-array / `{records}` / `{candidates}` result
shapes; `get_user`'s `{ identity, roles, profiles, availableSections }` shape
falls through unchanged. So the manual `resolveRowScope` + strip-`employee`/
`candidate`-keys block above is required — it is the entire enforcement, not a
belt-and-suspenders duplicate. The `redactSalary` half of the same guard
(`stripKey(result, 'salaryRange')`) **does** work on any shape and runs for free
via the registry after `execute()` returns; it is additionally redundant with
`fieldProjector`'s own per-field `requires: 'employees.manage', orSelf: true`
gate on `salaryRange` (`providers/employee.js`) — two independent layers
protecting the same field is intentional defense-in-depth, not a bug to
simplify away.

**Ruling R8 — only `employee`/`candidate` profile sections are row-scope
gated, not `student`/`mentor`/`recruiter`/`agent`/`administrator`.**
`resolveRowScope`/`applyEmployeeListScope` exist specifically to mirror the
Employees-page's Agent/SalesAgent ownership scoping (§0). No equivalent
per-row ownership scoping exists anywhere in this codebase for Student/Mentor
records — their visibility is already fully governed by `fieldProjector`'s
namespace-level `requires: '<ns>.read'` gate (e.g. `students.read`). Stripping
those sections too would be inventing a restriction the rest of the product
doesn't have. If a viewer who can't see this person on the Employees/Candidates
page also shouldn't see their Student/Mentor data, that's a product decision
outside this contract's scope (flagged as Open risk OR2, not resolved here).

- **Result size:** `profiles` is a nested object, not a top-level array — the
  registry's `shrinkToFit` (§0) never touches it. Not a practical risk: every
  `FIELDS` declaration across `employee.js`/`candidate.js`/`student.js`/
  `mentor.js` is either a short scalar path or a `derive`d "…Summary" string
  (already bounded at the provider level); there is no raw long-text field
  (resume body, notes blob) in any provider's `FIELDS` map. No extra bounding
  needed — record this reasoning here so a future large free-text field addition
  to a provider knows to add its own bound (like `get_job`'s `boundDescription`),
  since the registry cap won't catch it.
- **Render:** reuse `personProfile/profileTableBlock.js`'s `buildProfileTableBlock(profile)`
  directly — it already accepts exactly the `{ kind: 'unique', identity, profiles }`
  shape `get_user`'s success result carries (constructed to match on purpose).
  `matches`/`error` results render no block. `facts.counts`: `[{ kind: 'get_user', label: 'users', total: 1 }]`
  on a unique find (per task-3-brief's "facts label `users`"); no count fact for
  `matches`/`error` results (not a countable "N users" claim).

---

## 6. `list_roles`

```js
input: Joi.object({
  status: getRoles.query.extract('status'), // Joi.string().valid('active', 'inactive')
})
```
- **Access:** `ROLES_ACCESS`.
- **Default:** no default — matches `GET /roles`'s own behavior (its
  `getRoles.query.status` has no `.default()` either; omitting the filter shows
  every status). Roles are a small, admin-curated catalog (not a paginated
  population like Users), so "what roles exist" defaulting to "all of them,
  including inactive" is both the safer and the page-consistent choice — unlike
  Users, there's no headcount-inflation risk from including inactive rows.
- **Service call:** `queryRoles({ ...(status ? { status } : {}) }, { limit: 200 })`
  (`Role.paginate` — 200 is comfortably above any real role count; if that ever
  needs a real limit param, revisit, out of scope here) for
  `{ id, name, aliases, status }`. **Ruling R9** (below) computes `userCount`
  itself rather than reusing `queryRoles`' own `assigneeCountTotal`/
  `assigneeCountActivePending` fields.

**Ruling R9 — `userCount` is a fresh, purpose-built aggregate that mirrors
`count_users`' own default scoping exactly, not a reuse of
`role.service.js`'s existing `assigneeCountTotal`/`assigneeCountActivePending`.**
`queryRoles` already attaches those two fields (via `getAssigneeCountsByRoleId`)
for the Settings → Roles admin page, and they already exclude
`platformSuperUser`. But they do **not** exclude `hideFromDirectory` users, and
`assigneeCountTotal` counts every status (no `active` default) while
`assigneeCountActivePending` fixes `active+pending` unconditionally (no way to
ask for exactly what `count_users`'s default view shows). Task-4-brief's escape
hatch ("if scoping can't be applied to an aggregate, omit userCount... record
the ruling") is read here as license to build the small aggregate rather than
accept a number that would silently disagree with `count_users groupBy:role` for
the same role — and a disagreement between the two is worse than one extra
aggregate, because a Sage user comparing "how many recruiters" (`count_users`)
against `list_roles`' own recruiter row must get the same number. The aggregate:
```js
const hiddenIds = viewerSeesHiddenUsers(ctx.user) ? [] : await getDirectoryHiddenUserIds();
const rows = await User.aggregate([
  { $match: { status: 'active', ...EXCLUDE_PLATFORM_SUPER, ...(hiddenIds.length ? { _id: { $nin: hiddenIds } } : {}) } },
  { $unwind: '$roleIds' },
  { $group: { _id: '$roleIds', count: { $sum: 1 } } },
]);
const byRoleId = new Map(rows.map((r) => [String(r._id), r.count]));
```
then `userCount: byRoleId.get(String(role._id)) ?? 0` per row. This exactly
matches `count_users`' own default (`status: 'active'`, hidden-user exclusion
conditioned on the same `viewerSeesHiddenUsers` check, `platformSuperUser`
excluded). Document on the row that `userCount` reflects *active* users only
(same "default" framing as `count_users`), and that a user with 2 roles counts
toward both roles' `userCount` — same "counts in both" rule as `count_users
groupBy:role`, for the same reason (`$unwind`).
- **Render:** table block (Name | Aliases | Status | Users) + no count facts
  (a role listing isn't a single countable "N users" claim — `userCount` is
  per-row, same reasoning as `count_jobs`'s groupBy output).

## 7. `get_role`

```js
input: Joi.object({
  name: Joi.string().min(1).required()
    .description('Role name, or part of it — matches name, alias, or a former name.'),
})
```
- **Access:** `ROLES_ACCESS`.
- **Resolution:** reuse `resolveRoleNames([name])` (§1) — same exact-match
  semantics (name/slug/alias/previousName, case-insensitive, any status) as the
  `count_users`/`list_users` role filter, so "what can a Sales Agent do"
  (`get_role`) and "how many sales agents" (`count_users` with a role filter)
  resolve the identical role(s) for the identical input string. One shared
  resolver, two call sites — no drift.
- **Zero matches:** `{ matches: [] }` (same empty-array convention as `get_user`,
  for consistency across the domain — not `{ notFound: true }`).
- **>1 match:** `{ matches: [{ name, slug }, ...] }` (role name collisions across
  aliases are rare but possible per `roleRegistry.js`'s own comment about legacy
  duplicate 'Agent'/'agent' docs — ask which one, same pattern as `get_job`).
- **Exactly 1 match:** `{ name, slug, aliases, status, permissions }` (per
  brief). No `userCount` here — that's `list_roles`'/`count_users`' job; keeping
  `get_role` a pure definition lookup avoids a second `userCount` computation
  with its own scoping question to answer.
- **Render:** a compact key/value block (Name, Aliases, Status, Permissions —
  join permissions with commas or a small list) + no count facts (not a
  countable claim).

---

## 8. `people/index.js` instructions (guidance for `matchesTurn`/model routing)

Per task-3/4 briefs' examples, the instructions string must say, in substance:
- Users: user accounts, logins, "who has role X", "how many admins" →
  `count_users`/`list_users` with a `role` filter — **not** `list_roles`.
- "What can a Sales Agent do" / "what permissions does X role have" → `get_role`.
- Status defaults to active for user counts/lists; say so when not overridden.
- `groupBy:'role'` counts a user once per role they hold; a user with no role is
  excluded from every group.
- A short follow-up that's just a person's name is a `get_user` call, not a
  `count_users`/`list_users` filter (mirrors jobs' identical warning about names
  landing in `search` by mistake).

---

## Rulings summary

| # | Decision |
|---|---|
| R1 | `platformSuperUser` excluded unconditionally in `count_users`, `list_users`, `list_roles.userCount` — `buildUserListMongoFilter` doesn't do this; mirrors `role.service.js`'s existing per-role counts. |
| R2 | **The brief's named decision.** Role filter resolves *any* role name (name/slug/alias/previousName via the Role collection), not the REST page's 3-value enum (`recruiter`\|`referral_eligible`\|`sales_agent`). Unknown name → tool error listing valid names. |
| R3 | Role filter never sets `buildUserListMongoFilter`'s `role` key; resolved ids go in as `roleIds: { $in: [...] }` instead. |
| R4 | `filters.location`/`domain`/`education` (singular) map to `buildUserListMongoFilter`'s `locations`/`domains`/`education` (plural/list) keys. |
| R5 | `status: 'all'` is a Sage-only sentinel stripped before calling `buildUserListMongoFilter` — never sent as a literal string. |
| R6 | `get_user({ id })` must call `getUserByIdForRequester` before `resolvePersonProfile({ userId })`, because the `userId`-path loader skips the `hideFromDirectory`/`platformSuperUser` check that the `person`-path already has. |
| R7 | `get_user`'s `rowScope: 'person'` access flag only buys the automatic `redactSalary` pass (shape-agnostic); the Employees/Candidates row-scope check itself must be hand-implemented in `execute()`, because `applyRowScope` doesn't recognize `get_user`'s result shape. |
| R8 | Row-scope stripping in `get_user` applies only to `profiles.employee`/`profiles.candidate` — Student/Mentor/etc. have no ownership-scoping concept anywhere in this codebase to mirror. |
| R9 | `list_roles.userCount` is computed by a fresh aggregate matching `count_users`' own default scoping (active, hidden-excluded, platform-super-excluded) — not a reuse of `role.service.js`'s existing `assigneeCountTotal`/`assigneeCountActivePending`, which lack hidden-user exclusion and don't default to "active". |

## Open risks (not resolved by this contract — flagging for awareness)

- **OR1 — inactive-role blind spot in `resolvePersonProfile`.** A user whose
  *only* role is inactive gets `kind: 'unavailable'` from `get_user`, and a user
  holding one active + one inactive role won't show the inactive one in
  `identity.roles`/`profiles` (though it *will* show in `get_user`'s own
  `roles[]`, per Ruling R6's fresh lookup — a visible asymmetry). Root cause is
  `roleRegistry.js`'s active-only cache, shared with the legacy
  `resolve_person_profile` tool and the whole conversational person-resolution
  path — fixing it is a `roleRegistry`/`personProfile` change well outside this
  people-tools contract.
- **OR2 — Student/Mentor profiles have no row-level ownership scoping.** Ruling
  R8 accepts this as consistent with the rest of the product (no such scoping
  exists today for those record types anywhere), but if that's ever judged a
  gap, it's a product decision, not an oversight in this contract.
- **OR3 — `getUserPermissionContext` (used inside `resolvePersonProfile`)
  re-derives permissions fresh from `user.roleIds`, independently of
  `ctx.user.authContext.permissions`** (used by `toolAccess.js`'s
  `checkAccessRule`/`resolveRowScope`/`redactSalary`, i.e. everywhere else in the
  agent). Both should normally agree (same underlying role assignment) since
  `authContext` is itself derived from the same permission service at auth-middleware
  time, but they are two independently-executed code paths — a future drift
  between them would surface as `get_user` disagreeing with `count_users`/
  `list_users` about what the same viewer can see. Not observed, not a change
  made here — noted for whoever debugs that class of bug first.
