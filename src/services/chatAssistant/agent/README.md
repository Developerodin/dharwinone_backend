# Sage's agent loop

## What this is

Sage (the chat assistant) answers every chat turn through a tool-calling loop on
OpenAI's Responses API: the model picks one or more tools, the tools query the
real service layer, and the model writes the final reply from the results.
Greetings, thanks and general-knowledge definitions are answered with no tool
call. There is no other pipeline: a turn the loop cannot answer gets a fixed
reply (request flow, step 5), so the chat never goes dark and never throws to the user.
The legacy deterministic router and its `CHATBOT_AGENT` / `CHATBOT_TWO_STAGE` flags were
removed in R9 (2026-09-29).

## Request flow

1. `chatAssistant.controller.js` calls `sendMessage` or `streamMessage`
   (`chatAssistant.service.js`). Both trim the request's messages to the last 6
   non-empty ones and call `tryAgentTurn` (`agent/gate.js`).
2. `tryAgentTurn` loads the user's `ConversationMemory` row (for the tool ledger) and
   calls `runAgent(...)` (`agent/runAgent.js`) — on every turn, with no routing test.
3. `runAgent` builds the tool list with `getAgentTools(user)` (`agent/toolRegistry.js`),
   permission-filtered so the model never sees a tool the user can't call. With at most
   `EAGER_TOOL_LIMIT` (30) permitted tools, not counting `handoff`, every permitted schema and
   its domain's instructions go into the prompt as before. Above that the registry is lazy: the
   model gets only `handoff` + `find_tools` and loads domains on demand (see "Lazy tool loading"
   below). The loop then calls `llm.step(...)` (`agent/llm.js`) up to `CHATBOT_AGENT_MAX_STEPS`
   times, passing that turn's active schemas each time: each step may return tool calls, which
   the registry's `execute(name, args)` runs — capped at `MAX_CALLS_PER_STEP = 8` per step; any
   call beyond the first 8 gets a canned `{"error":"too many calls in one step"}` output instead
   of actually running — or a final text answer.
4. Successful tool results are rendered (`tool.render(result)` → `{ blocks, facts }`),
   the facts are merged and passed to `enforceCounts`, which corrects counts against this
   turn's tool totals. `runAgent` returns `{ reply, blocks, meta, ledgerEntry }`;
   `tryAgentTurn` persists `ledgerEntry` onto `ConversationMemory.agentLedger` via
   `appendAgentLedger` when it holds at least one tool call (a no-tool answer writes
   nothing) — `runAgent` itself never writes to the DB.
5. Anything that isn't a clean answer makes `runAgent` return `null` and report an
   outcome through its `onOutcome` callback; `tryAgentTurn` turns that into a fixed,
   digit-free reply (`SAGE_REPLIES` / `fallbackReply` in `gate.js`) with no blocks, and
   logs `[agentGate] fixed reply … outcome=<outcome>`:
   - `handoff` (the model called `handoff`: no tool fits) → "I don't have that in the system
     right now. I can help with …" (the old `SAGE_FALLBACK` wording);
   - `untooled_number` (a digit in a reply with no successful tool call) → "I couldn't check
     that against the system, so I won't guess a number …";
   - `error`, `deadline`, `repeated_tool_failure`, `empty` (a thrown error or timeout, the
     turn deadline, the same tool failing twice, an empty reply still empty after one
     `tool_choice:'none'` retry), or a throw inside `tryAgentTurn` itself (e.g. the memory
     read) → "Sorry, I couldn't answer that right now. Please try again in a moment."
6. The service wraps the result in the `{ reply, blocks, meta }` envelope
   (`renderers/types.js`). `sendMessage` returns it; `streamMessage` has no token stream to
   relay (the agent has none), so it sends the whole reply as one `onToken` (the `{ token }`
   SSE event) and then `onDone(envelope)` (the `{ done, blocks, meta }` event) — the same
   events the frontend already consumes. An answered turn's `meta` is
   `{ kind: 'jobs', deterministic: false, tookMs }` (the value the agent path always sent);
   a fixed reply's is `{ kind: null, deterministic: false }`.

```
controller --> sendMessage / streamMessage (chatAssistant.service.js)
                  |
                  v
              tryAgentTurn (gate.js) --loadMemDoc--> runAgent --getAgentTools--> llm.step (loop, <=8 calls/step) --> registry.execute
                  |                                     |
                  |<------ answer {reply, blocks} ------+   (ledger entry appended when a tool ran)
                  |<------ null + onOutcome(handoff | untooled_number | error | deadline | ...)
                  v
              the answer, or a fixed reply (SAGE_REPLIES) --> { reply, blocks, meta } envelope
```

## Lazy tool loading

- **Threshold.** `getAgentTools` counts the user's permitted domain tools (`handoff` excluded).
  Up to `EAGER_TOOL_LIMIT = 30` it is eager, exactly as before. Above it `lazy` is `true`: the
  stable prefix carries `LAZY_INSTRUCTIONS` instead of the domain instructions, and the only
  schemas are `handoff` and `find_tools`.
- **`find_tools`.** Its description is a catalog of the domains the user has at least one tool
  in, one line each as `domain — summary` (the domain module's `summary`); its input accepts only
  those domain names, 1 to 5, no repeats (`parseFindToolsArgs` enforces the minimum and
  uniqueness, which `toJsonSchema` cannot express). The loop handles the call itself: the
  registry's `loadDomains(names)` returns those domains' permitted schemas and instructions, the
  schemas join the active set for the next step, and the instructions come back as the call's
  output. Unknown or unpermitted names load nothing.
- **Compaction.** `find_tools` outputs are the only copy of the loaded domains' rules, so
  `compactTurnItems` never drops them (`keepTools`).
- **One free step.** A step whose calls are all `find_tools` does not count against
  `CHATBOT_AGENT_MAX_STEPS`, once per turn — loading tools is not progress on the answer.
- **`find_tools` is not an answer.** It returns no company data, so it never satisfies the
  `untooled_number` check, is never rendered and is never written to the ledger. It is still
  listed in `meta.toolCalls`.
- **Ledger preload.** On a lazy turn, the domains of the tools called in the last ledger entry
  are loaded before step 1 (a follow-up usually stays in the same domains). Their instructions
  ride in one extra `developer` message after the turn context (`buildAgentInput`'s
  `preloaded`), not in the stable prefix, so the prompt cache still hits.
- **Logs and evals.** `[runAgent]` logs `lazy` and `toolsOffered` (the size of the final active
  schema set). `scripts/sage-agent-evals.js --eager` forces every permitted tool up front for an
  A/B against the default lazy run; `--check` validates every case file offline (no OpenAI, no
  DB): JSON, unique ids, every expected tool registered and visible to `FAKE_USER`, and a canned
  result for every registered tool — cheap enough for CI.
- **Ceiling.** The catalog grows by one line per domain and sits in every lazy prompt; past a
  few dozen domains the upgrade is nested domains or embedding-based tool search.

## Registered domains

### jobs

The reference domain (`agent/tools/jobs/`): `count_jobs`, `list_jobs`, `get_job`,
`rank_jobs_by_salary`, `get_job_stats`. Access is `jobs.read`. `filters.jobOrigin: 'external'` plus
`filters.externalSource` (one feed or an array) answer external / LinkedIn job questions — only
listings mirrored into the Jobs page, never the raw External Jobs collection. `get_job` also returns
`pay` (the Jobs page Salary column; "Not specified" for no range or 0–0), `createdBy`, `recruiter` (null
= the job creator approves interview times) and `applicationDeadline`; `project` and `workAuthorization`
are always null (the Job model has neither — not captured in DharwinOne). `get_job_stats` with a jobId or
title gives one job's page funnel, `interviewed`, hires, openings left, time-to-fill and a close
suggestion (never an action); without one it ranks every matching job (ceiling 5000, said when hit) by one
grouped count from `applicantQuery.service` `aggregateApplicationsByJob` — one application per person per
job, the page's dedupe, under the viewer's scope. Time-to-fill runs from posting to the last hire's
`Offer.acceptedAt` (fallback `updatedAt` for offer-less hires), only once every opening is filled.
`hired` counts every hire on the job (the "filled" badge); hire rate counts only rows the viewer can see
(`hiredBasis`).

### referrals

`agent/tools/referrals/`: `get_referral` — referrer, sales agent, lead and attribution ids, channel,
date, override, and who issued the link (`ActivityLog` `referral.link.issued`, first 5 matches). "Direct"
only when no referrer is recorded; a referred person outside the viewer's Refer Leads scope comes back
`unlisted`, never direct and never with details. `get_referral_stats` — page counts per agent or the
viewer's own scope (referred, applied, never applied, active, offers, joined, conversion), exact average
days referral → joining (the basis says how many joined leads had no usable dates), days in stage per open
stage (`referralLeads.service` `getReferralOpenStageAges`: entry date from the record that put the lead
there), IST month-over-month. Ranking is org-wide viewers only, one grouped query
(`getReferralLeadsStatsByAgent`). Access is `candidates.read` with the Refer Leads page scope: a Sales
Agent's "me" = leads they referred or are the agent for; naming another agent is refused before any lookup.
WhatsApp shares and link opens are not captured.

### people

`agent/tools/people/` (`CONTRACT.md` in that directory is the binding spec). Covers user
accounts (logins) in the Users directory and the roles those accounts hold — **not**
Employee/Candidate/Student/etc. profile data beyond what `get_user` surfaces. Status
defaults to `active` for user counts/lists unless the caller asks for another status or
"all".

| Tool | Purpose | Key args | Access |
|---|---|---|---|
| `count_users` | Count user accounts, optionally grouped by `role` or `status`. With `groupBy:'role'`, `total` is a distinct-user count (never the sum of the groups — a user with 2 roles counts in both groups, so the raw sum is kept separately as `assignmentCount`); with `groupBy:'status'` the sum is the correct total, since status is exclusive. | `filters` (search/status/role/location/domain/education), `groupBy` (`role`\|`status`) | `users.read` |
| `list_users` | List user accounts (`id`, `name`, `email`, `roles`, `status`, `lastLoginAt`), newest first; `total` is always the full filtered count. | `filters`, `limit` (default 10, max 25) | `users.read` |
| `get_user` | One person's full profile (user account + every role-specific profile they hold), by id or name. Name resolution excludes the platform-super account (unless the viewer is one) and deleted accounts, and prefers a single exact name/email match over asking to disambiguate. Ambiguous name → `{ matches }`; no match → `{ matches: [] }`. | `id` or `name` (one required) | `users.read`, `rowScope: 'person'` |
| `get_my_profile` | The signed-in user's own profile ("my profile", "who am I", "my employee id"). Separate from `get_user` so it needs no `users.read`; self field rules come from `resolvePersonProfile` (impersonation is never self). | none | `{ note }` (self only) |
| `what_can_i_do` | The signed-in user's own role permissions, by module, and the modules they cannot see (same source as `GET /auth/my-permissions`). Another role's permissions stay on `get_role`. | none | `{ note }` (self only) |
| `list_roles` | List the roles defined in the system, with how many active users hold each. | `status` (`active`\|`inactive`) | `roles.read` |
| `get_role` | One role's definition: name, aliases, status, full permission list. Exact match only (name, alias, or a former name) — no partial match. | `name` (required) | `roles.read` |

Routing notes (see `agent/tools/people/index.js`'s `instructions` for the full text the
model reads): "how many admins/recruiters/sales agents" and "who has role X" are
`count_users`/`list_users` with a `role` filter, **not** `list_roles`; "what can a Sales
Agent do" / "what permissions does X role have" is `get_role`; a short follow-up that's
just a person's name is a `get_user` call, not a filter on the previous `count_users`/
`list_users` call. `count_users` / `list_users` also take `filters.inactiveDays` (no password
sign-in for N days) and `filters.neverLoggedIn`; `list_users` stays at default 10, max 25.
Full rulings and rationale: `agent/tools/people/CONTRACT.md`.

### employees

`agent/tools/employees/`: `count_employees`, `list_employees` — Employee-role profiles only
(`ownerUserRole: 'employee'`), current employees unless `filters.employmentStatus` says
otherwise. `count_employees` can `groupBy` `department`, `designation`, `employmentType`,
`compensationType` or `employmentStatus`. `filters.joinedBetween` / `resignedBetween` (`{ from, to }`,
`YYYY-MM-DD`, inclusive whole days in `context.js` `DEFAULT_TIMEZONE` (IST) — the zone the model resolves "today" in; impossible or reversed days throw) answer "who joined / resigned in <period>" and default
`employmentStatus` to `all`; "joined" about placements or hires goes to `count_placements` /
`list_placements` (status Joined) in the hiring domain. Both run through `executeEmployeeQuery`, so row
scope and salary masking match the Employees page. Access: the Employees page read/manage
permissions (`EMPLOYEE_QUERY_READ_PERMISSIONS`).

### candidates

`agent/tools/candidates/`: `count_candidates`, `list_candidates` — Candidate-role profiles
only (`ownerUserRole: 'candidate'`). Candidate and Employee are distinct roles and are never
aliased or merged; a missing Candidate role matches nothing. Same executor and access as
`employees`. `match_candidates_to_job` ranks Candidate profiles (or, with `pool: 'employees'`,
current employees) against one job the viewer can see: Pinecone `employees` namespace for
similarity + skill overlap, then role and row scope through `buildEmployeeListMongoFilter` /
`applyEmployeeListScope`.

### applications

`agent/tools/applications/`: `count_applications`, `list_applications` — job applications by
applicant, job title/id or status, via `applicantQuery.service`'s `searchApplications`. Access
is delegated to its `applicationScope` (admin / recruiter / sales agent / self), so the tools
declare an access note rather than an `anyOf`.

### hiring

`agent/tools/hiring/`: the ATS pipeline after an application. Every tool calls the page's own service
with the viewer, so row scope is the page's; each `access` mirrors that page's GET route.

| Tool | Backed by | Access (route) |
|---|---|---|
| `count_interviews` / `list_interviews` | `meeting.service` `queryMeetings` (Interviews page; `meetingScope`: full interviews access = all, else own). Filter = the page's `buildMeetingsMongoFilter` + interviewer + result. `byStatus` / `byResult` (+ `resultNotSet` for legacy rows). `resultMissing` = status ended + result pending/unset. `overlapping` (needs `scheduledBetween`, max 300 in window) = a shared panel member (id or email) with overlapping time among interviews the viewer can see; the scan starts 8 h early. Job ids shown as titles. Results are pending / selected / rejected only — no "hold". | `interviews.read` |
| `get_interview` | By id or candidate (+ `jobPosition`): panel, scheduled by / on, attendance (`participantRoster`), history (result changes and invite re-sends from Activity Logs, under that page's gate and grading, else `historyHidden`), recording + playback link, AI summary (`interviews.summary.read`, else `aiSummaryHidden`), evaluations. Fire-and-forget view audits identical to the portal's, tagged `source: 'sage.chat'`; none on notFound / denied. RSVP, invite delivery and reschedule history are not captured. | `interviews.read` |
| `get_interview_transcript` | `interviewTranscript.service` `getInterviewTranscript` (latest version, `meetingScope`): speakers, time chunks, `includeFullText` ≤ 12,000 chars. Writes the portal's `TranscriptVersion` audit row. | `interviews.transcript.read` (= `GET /meetings/:id/transcript`); by name also `interviews.read` |
| `count_offers` / `list_offers` | `offer.service` `queryOffers`. Count returns `byStatus`. CTC only for `candidates.manage` / `employees.edit` / `offers.edit` / `offers.manage` (the Offer Letter Generator gate), otherwise `compensationHidden`; never `offerLetterUrl` or `rejectionReason`. `filters.pendingOverDays` → `sentBefore` (Sent / Under Negotiation, marked Sent before the IST day N days ago; `sentDateMissing` = pending with no sentAt, never counted); `acceptedNoPreboarding` → `placementStatus` / `placementPreBoardingStatus` Pending. Exact totals. | `offer.route.js` `canReadOffers` |
| `get_offer` | One offer by candidate or `offerCode`: prepared by / at, `markedSentBy` / `markedSentAt` (RecruiterActivityLog `offer_sent`), days pending, a `delivery` note (auto notice email; the Outlook letter is not captured), `letter.pdfUrl` and compensation only via `canSeeOfferCompensation`. | `canReadOffers` |
| `count_placements` / `list_placements` | `placement.service` `queryPlacements`. Cancelled left out unless asked; `stage` = the Pre-boarding / Onboarding queue; `joiningBetween` for "joined this month". `bgvPending` → `bgvStatus`; `readyForBgv` → BGV Pending, not requested, paperwork complete (`PAPERWORK_COMPLETE_MATCH`); `joinDatePassedNotOnboarded` → `joiningTo`. Exact totals. The service itself rewrites drifted joining dates and runs the Employee-role promotion backfill, as the page does. | `placement.route.js` `canReadPlacements` |
| `get_placement` | One person's placement: steps, first blocking step (IST joining day), agent / department, whether they hold the Employee role; `auditTrail` (`listAuditForPlacementId`, 20 newest) with placement.audit / candidates.manage. | `canReadPlacements` (+ audit route) |
| `list_documents` | Documents for one `person`, a `cohort` (placement filters, ≤ 500 rows, `scanTruncated`), or the viewer's own: uploaded, missing (requested, not uploaded), pending review, approved, rejected with reason, EAD / visa expiring. Without `userCanViewPreBoardingDocs` a person lookup only resolves a profile you own (no name enumeration). | `employee.route.js` `canReadCandidateDocuments` |
| `get_hiring_funnel` | `referralLeadsAnalytics.fetchHiringTunnelSnapshot` → `getReferralLeadsStats` (Refer Leads page cards). | `candidates.read` |
| `list_referral_leads` | `referralLeadsAnalytics.searchReferralLeads` → `listReferralLeads`. Referrer / sales-agent names resolve only among users who hold that role on some referral lead (never the whole user directory); several → `{ matches }` with names only. "me" (or the viewer's own name) needs no lookup; a viewer the page scopes to their own leads cannot name anyone else. Day windows go to the service as IST instants (`referredAtUpperBound` takes a full-instant `to` as-is). | `candidates.read` |

Counts are the page's own service count per status/result bucket. Every day window (`scheduledBetween`, `createdBetween`, `joiningBetween`, `referredBetween`, `claimedBetween`) is bounded by the same `employees/common.js` `dayWindowBounds` as the employee windows. Interviews are never internal meetings (those are the `meetings` domain).

### meetings

`agent/tools/meetings/`: `count_meetings`, `list_meetings`, `get_meeting` — internal meetings
(`InternalMeeting`) via `internalMeeting.service` `queryInternalMeetings`, so row scope is the page's
`internalMeetingScope` (all four `meetings.*` = every meeting; otherwise created / hosting / invited).
`filters.when` upcoming | past | earlier_today (IST midnight → now), `status`, `scheduledBetween` (whole IST
days), page search, `mine`. `status` "ended" includes meetings auto-ended when their slot passed — never
proof anyone attended. `list_meetings` defaults to 20 rows of page-visible fields (no description,
`invitedCount` not emails); `hasRecording` is one batched `Recording.distinct` over the page's room ids
(status `completed`), null without `meetings.read` / `onboarding.edit` or on lookup failure.

`get_meeting` (id / room id via `getInternalMeetingById`, which 404s outside scope, or title + optional IST
date; several → `{ matches }`) returns hosts, attendees from `participantRoster` (names, roles, join times),
a signed expiring recording link, and the AI summary read from `Summary` by room name
(`InternalMeeting.meetingId`): executive summary, decisions, action items. Only InternalMeeting ids resolve,
so interview summaries (gated `interviews.summary.read`) never surface here. No portal page shows
internal-meeting summaries today — Sage is the only reader. Access: `meetings.read` or the
orientation-meeting permissions.

### communication

`agent/tools/communication/`:
- `search_my_mailbox` (`emails.read`) — the caller's own Gmail / Outlook accounts only (the client reloads
  the account by `{ _id, user }`); `threadId` + `accountId` reads one thread to summarise. Outlook's provider
  searches one quoted phrase, so the tool sends the words and post-filters `person` on from / to / cc. A
  token refresh may write the account, as the portal does.
- `search_chat` (`chats.read`) — the caller's 50 most recent conversations, `searchMessages` per
  conversation (membership re-checked, deleted / hidden excluded, regex escaped); `partial` when cut.
- `list_email_activity` (Administrator by name, or `activity.delete`) — `EmailLog` platform send attempts
  via `email.service` `queryEmailLogs` (explicit projection, never metadata): to, person, type, subject,
  status (sent / failed / suppressed / pending), error, sentAt. "Sent" = accepted by SMTP; bounces and
  opens are not captured. Mail to directory-hidden users is excluded for non-platform-super viewers.

### audit

`agent/tools/audit/`: `list_activity` reads Activity Logs through the page's own gates —
`requireActivityLogsListAccess`, then `resolveActivityLogListFilter` (view = own rows, create + edit = own
rows with filters, delete / manage = everyone), both run inside `execute`, so the access is a `note`.
Filters dropped by the viewer's access come back as `ignoredFilters`. A person target (Employee) matches rows
stored as Candidate or Employee, by id or by name. `changes` (array or the older object shape, via
`normalizeChangesArray`) are `valueHidden` for pay, credentials, identity documents and contact details, and
for any value that is a link or an email address. `list_impersonations` ("Login as" sessions) needs
`users.impersonate` or the Administrator role by name, like `POST /auth/impersonate`; below the
see-everyone Activity Logs tier it returns only the viewer's own sessions (`scope`). The reason for an
impersonation and the pages viewed during it are not captured.

### calls

`agent/tools/calls/`: `count_call_records`, `list_call_records`, `get_call_record`, `get_call_metrics`,
`list_call_followups`. Call Records (AI agent + dialer) through `callRecord.service` with the viewer's
`userId` / `userIsAdmin`, so row scope is the page's. Every filter (IST `calledBetween`, direction, provider,
`mine` / `placedBy`, candidate id) runs in Mongo: `listCallRecords` for rows, `countCallRecords` /
`groupCallRecords` / `summarizeCallRecords` for exact counts on the same cast filter. Counts are raw records
like the page total (a Twilio dialer call may be two legs). A `callType` filter also reports
`unclassifiedCalls` (older rows with no call type). Transcript / AI fields go through `sanitizeCallRecord`
(`call-transcripts.read` / `call-ai.read`); recording links need `call-recording.view`. Access is
`calls.view`. `hangupBy` / `hangupReason` come from Bolna's telephony data (AI agent calls only).
`list_call_followups` and the applicant metrics also need `candidates.read` and use the Applications page
scope (`buildApplicantQuery`): callbacks from `JobApplication.verificationCallbackAt` (due / overdue around
now − 5 min), not-yet-called = open applications with no verification call and no CallRecord for that
candidate + job (dialer calls carry no candidate/job link, so they don't count as called). Not captured:
attempt number, hang-up side on dialer calls, salary / joining date / questions / concerns / other offers.

### knowledge

`agent/tools/knowledge/`: `search_knowledge_base` — a thin wrapper over `kbQuery.service`'s `queryKb` for
policy / FAQ questions. The KB is the voice agent created by the viewer's `adminId` (or the viewer), as the legacy
tool did — a creator pointer in a single-company deployment, not the one-level adminId walk. The answer is capped
at `MAX_ANSWER_CHARS`; a KB miss, no configured KB or a KB error come back as `found: false`.

Single-person lookups for any of these stay on `get_user`.

### schedule

`agent/tools/schedule/`: `get_work_schedule` (shift, week-off, upcoming ASSIGNED holidays and
leaves allowed — the viewer's own Employee profile, else their Student profile; `person` resolves
another employee through `executeEmployeeQuery`, so it needs an Employees-page read permission and
gets that page's row scope), `list_shifts` (`shift.service` `queryShifts`, `students.read` like
`GET /shifts`; `includeAssignees` adds `queryShiftAssignees` rosters and needs `attendance.assign`
like `GET /shifts/:id/assignees`), `list_holidays` (`scope: 'mine'` = the holidays assigned to the
viewer's profile, what the portal shows them; `scope: 'company'` = the Holidays page via
`holiday.service` `queryHolidays`, `students.read`). Windows go through `employees/common.js`'s
`dayRange`.

### org

`agent/tools/org/`: `get_org_structure` — the Org Chart's own services (`orgStructure.service`
`getOrgCoverageSummary` / `listOrgUnits` / `buildTree`) through `orgStructureAnalytics`'
payload builder, plus `managerCounts.fetchOrgManagersAnalytics` for `metric: 'people_managers'`.
Access is `chart.read` / `structure.read` / `structure.manage` (`canReadTree`). Chart departments
are OrgUnits, not the `Employee.department` text field (`count_employees groupBy department`); the
domain instructions say which is which. "Manager" has three meanings — chart positions
(`get_org_structure` `positions`), designation (`count_employees` `filters.designation`) and people
with direct reports (`people_managers`); a bare "how many managers" answers the first two. This
replaces the legacy `businessConcepts.js` clarification flow.

`get_reporting_chain` (same access) has five modes: `chain` (a person's team lead → supervisor → manager →
CEO up the chart, plus their `reportingManager` field and workforce team leads), `direct_reports`
(employees whose `reportingManager` is this person, and chart units they head), `no_reporting_manager` and
`no_group` (active employees with no reporting manager / in no chart department), and `group_moves`
(`EmployeeTransfer` records with who approved and when; optional `person` and `movedBetween`, and it needs an
Employees-page read permission). A null reporting manager or team lead is "not captured", never guessed. When no employee has
`reportingManager` set (only Onboarding → Edit sets it), `no_reporting_manager` / `direct_reports` say the
field is not captured rather than presenting it as a finding.

### training

`agent/tools/training/`: `get_training_progress` in three modes. `person` (default) — assigned modules
with status and % done from `studentCourseQuery.service` `queryStudentCourses` (the My Courses page), for
the viewer or a named person (another person needs `students.read` / `students.manage` /
`students.courses.read`). `cohort` — a course and/or position's learners, filtered by `progress`,
`scoreBand` (`gte90`, `lt70`, `custom` with `minScore` / `maxScore`) or `inactiveDays` (whole IST days, today included; unfinished rows with no access or enrolment date
are counted as `noActivityDate`, not guessed); needs
`evaluation.read`. `position_map` — which courses each position gets; needs an Employees / Candidates /
positions read permission. Progress exists only on Student profiles: no Student profile returns
`noStudentProfile` (person) or lists them in `withoutStudentProfile` (cohort), never "0 courses".
`overdue` is always null with a note — modules have no due date in DharwinOne — and `atRisk` is offered
instead.

### attendance

`agent/tools/attendance/`: attendance, leave requests, on-leave-today and backdated attendance
requests. Every tool calls the service behind the matching portal page with the viewer, so row
scope is the page's, and self-service ("my attendance", "my leaves") works with no admin
permission. A named person resolves through the Employee collection (`resolvePerson`); naming
someone else needs a people/attendance read permission, and the page's own scope still applies
on top.

| Tool | Backend | Access |
|---|---|---|
| `get_attendance` | `attendance.service` `listByStudent` / `listByUser` (same source choice as `/attendance/candidate/:id`) | self always; another person needs `students.*` / `candidates.*` (`requireAttendanceAccess`) |
| `get_attendance_summary` | `attendanceAggregator.aggregateOrgAttendance` + `enrichAttendanceSummary`; window ≤ 92 days | `students.manage` (Attendance → Track) |
| `count_leave_requests` | `buildLeaveRequestScopeFilter` + count / group; `groupBy:'employee'` ranks leave days via `leaveRanking.js` (approved unless `filters.status`) | `note` — service scope |
| `list_leave_requests` | `leaveRequest.service.queryLeaveRequests` | `note` — service scope |
| `who_is_on_leave_today` | `onLeaveToday.service.getEmployeesOnLeaveToday` (dashboard grading) | `note` — service scope |
| `list_backdated_requests` | `backdatedAttendanceRequest.service.queryBackdatedAttendanceRequests`, plus per-status totals | `note` — service scope |

Day windows are `{ from, to }` `YYYY-MM-DD`, validated by `employees/common.js`'s `dayRange` and
turned into UTC-midnight day keys (`dayKeys`), because `Attendance.date`, `LeaveRequest.dates`
and `attendanceEntries.date` are day keys, not instants. Filters reach the services inside `$and`,
so a service that assigns its own scope (`Object.assign(filter, scope)` / `filter.$or = own`)
intersects with the person filter instead of overwriting it.

### projects

`agent/tools/projects/`: `count_projects`, `list_projects` (`project.service` `queryProjects`; viewers
without `projects.read`/`manage` get My Projects, `mine: true`), `list_teams` (`teamGroup.service`
`queryTeamGroups`, `teams.read`), `count_tasks` / `list_tasks` (`task.service` `queryTasks` with
`buildTaskServiceFilter`; without `tasks.read` or Administrator the tools force `assignedToMe`, like
`task.route.js`), and `get_workload` (`workloadAnalytics.fetchWorkloadAnalytics`, `projects.read`).
`count_tasks` `groupBy: 'status'` is the stage breakdown plus overdue and blocked counts. An assignee
name resolves to an `assignedTo` clause; unknown or ambiguous names return `notFound` / `matches`,
never an unfiltered count.

`get_allocation` (`projects.read` / `projects.manage`) answers the max-2-active-projects rule. `summary`
counts people on 0, 1, 2 and 3+ active projects; `list` names one bucket (`projects_0` … `projects_3_plus`,
`no_active_tasks`, `unallocated`, `overloaded` with `overloadAbove`, optional `designation`); `can_assign`
says whether a person can join a project and why. The rule lives in `services/projectCapacity.js`
(`MAX_ACTIVE_PROJECTS_PER_ASSIGNEE = 2`, active = In progress / On hold, `isAtProjectCapacity`), the same
helper `pmAssistant.service.js` now uses, so the chat and the PM assistant cannot disagree.

### person

`agent/tools/person/`: `get_person_360` composes other tools and does not query Mongo itself. It resolves
the person once (`get_user`'s name rules; `get_my_profile` when `person` is omitted; an ambiguous name returns
`{ matches }` and stops), then runs the sections in parallel through `compose.js` `runTools` under the
viewer's access: profile, referral, applications, calls, interviews, offer, placement, documents, org,
attendance (last 30 IST days), leave, training, projects / tasks, activity. Each section is
`{ status, summary, rows ≤ 5 }`; restricted or failed sections are never filled from another source. The
profile's roles decide which sections apply: referral, offer, placement and documents are skipped
(`notRecorded`) for an Employee without the Candidate role; org, attendance, leave and projects / tasks for a
Candidate without the Employee role. `focus: 'today'` = attendance, tasks due and approved leave today, plus
the viewer's own meetings only when the person is the viewer (others' meetings are `restricted`);
`focus: 'pending'` = open tasks, pending leave, missing documents, callbacks due, interviews awaiting a
result, an offer waiting on the candidate. External-job (bench marketing) activity is `notCaptured`.
One-fact questions (manager, department, joining date) stay on `get_reporting_chain` / `get_user`.
`find_duplicate_people` groups Employees-page-scoped profiles (`applyEmployeeListScope` +
`buildEmployeeListMongoFilter`, one `$group` aggregate) on normalised email (lower-case, trimmed) or phone
(digits only, last 10); access is `EMPLOYEES_ACCESS`.

### insights

`agent/tools/insights/`: `get_attention_digest`, `get_operations_summary`, `run_data_quality_checks` —
composites whose sections run Wave 1 tools via `compose.runTool`, so the tools' own access is a `note`.
Digest items are a fixed table in `digestItems.js` (tool, filter, severity, whether it has a "mine" filter
and a window); severity is fixed, never scored, and thresholds come from the `smartNudge` situations.
`scope: 'mine'` keeps only items with a "mine" filter and lists the rest in `notScopedToYou`;
`compareTo: 'previous'` re-runs the windowed items for the previous window of equal length
(`{ now, before, delta }`) and lists the rest in `noWindow`. Overdue training is `notCaptured` (no due
date). `get_operations_summary` is one module's key counts (recruitment / hr / pm / bench), each from a
Wave 1 count tool, plus that module's digest items. `run_data_quality_checks` runs the 17 BRD data-quality
checks, each `{ id, label, status, count, sample, source }`; duplicate phones / emails call
`find_duplicate_people`, and missing-field checks with no Wave 1 filter use the page's own scoped filter
plus one `$and` clause.

### crosscheck

`agent/tools/crosscheck/`: `run_cross_check` (18 named checks) and `get_recruitment_funnel`. Each check is
set A minus / intersect set B (`sets.js`), every set built from that page's own filter and scope and capped
at 5000 ids; `identity.js` maps between User / Employee / Student / candidate ids and counts unmappable ids
as `unmapped`. No access to one set makes the whole check `restricted`; a truncated set makes the answer
"at least". `applications_unchanged` uses `unchangedSinceFilter` and `lastStatusChangeAt`
(`applicationStatusHistory.js`) and reports whether each date came from `statusChangedAt` or `updatedAt`.
The funnel covers applications created in the window (Applications-page scope); stage dates come from
`stageEntryDates` and the answer reports `basis` (`tallyBasis`: history / derived / none, plus
approximate). Screening is `notCaptured` on the derived basis; onboarding and hired dates always come from
the placement record. Recruiter workload is pending items per recruiter, never a quality measure.

### advice

`agent/tools/advice/`: `explain_status` (why unavailable, can't join a project, can't move to onboarding,
not on the Employees page, not on the org chart, can't see a record) returns `rules: [{ rule, source, met,
evidence }]` taken from the real rule code, plus a one-line conclusion; `recommend` (8 kinds) returns the
ranking rules and items `{ subject, score, reasons, evidence }`; `match_jobs_to_employee` ranks active jobs
the viewer can see by skill-tag overlap with the employee's profile skills (keyword based — the vector
index holds people, not jobs). Sections go through `compose.runTool`; `follow_ups_today` calls
`get_attention_digest` with scope mine.

### actions

`agent/tools/actions/`: one domain (`actions/index.js`) that merges the tools and instructions of
`interviews/`, `documents/`, `training/` and `tasks/`. Every tool is `kind: 'write'`: it only drafts a
confirm card (see "How to add a write tool"), and the write runs only on
`POST /v1/chat-assistant/actions/:key/confirm`. Every confirm re-checks access and the draft first:
the interview and document tools re-run `prepare` and refuse unless the card would be identical
(interviews: targets, every line and payload; documents: payload), the training tools use the default
target-id check, and `create_task_plan` checks its stored preview.

| Tool | Access | Commit calls | Sends | Dedupe / refusals |
|---|---|---|---|---|
| `resend_interview_invite` | allOf `interviews.read`, `interviews.manage` (the resend route plus the `meetingScope` read it runs) | `meeting.service` `resendMeetingInvitations`, then the `interview.invitation.resend` ATS audit row with `metadata.sageAction` = key | Email with calendar invite to every invitation address, plus in-app for recipients with a login | Card lists every recipient with their role. Refuses a cancelled interview, no recipients, or over 50 addresses. A replay of the same key (audit row present) sends nothing. |
| `schedule_interview` | allOf `interviews.manage` (`POST /meetings`); prepare proves the application is in the viewer's Applications scope | `meeting.service` `createMeeting` with the body `interviewHold` approve builds | Invitation email with calendar invite plus in-app to every invitee; the automatic reminder email before the start | Card says whether the application moves Applied / Screening → Interview or stays, lists the invitees, and warns on panel clashes among interviews the viewer can see. Needs a 24-hex application id, a future time with an explicit offset, visible hosts. An interview for the same application at the exact time → refused at draft, skipped at commit. |
| `send_interview_booking_link` | allOf `interviews.manage` (no route; gated like scheduling) | `interviewBooking.service` `sendBookingLinkEmail` | Email only, to the candidate profile's email | Refuses when the profile has no email or scheduling is blocked (status, inactive job); warns when the job has no interviewer pool. Each new confirm sends a new link; a replay of the same key sends nothing. |
| `request_documents` | anyOf `candidates.manage`, `employees.manage`, `pre-boarding.create`, `pre-boarding.manage` (the controller's `canRequestPreBoardingDocs`), and prepare also requires the route's anyOf. `employees.edit` alone passes the route but the controller refuses it, so it is refused here too | `employee.service` `requestDocumentFromCandidate` per document, plus the `employee.document.request` ATS audit row | One notice (in-app and email, type `onboarding_reminder`) to the login whose email is the profile's email; owning the profile alone never makes a login the recipient (a recruiter owns public-apply profiles) | Labels already pending are skipped at draft and again at commit. With nobody to notify the requests are still created and the card says so. The notice lists only what this commit created, so a replay sends nothing. |
| `remind_pending_documents` | Same as `request_documents` | `notification.service` `notify` / `notifyByEmail` (no document write) | One notice (in-app and email) listing every pending request | Refuses when nothing is pending, nobody can be notified, or a `done` reminder for that profile exists in the last 24 h (SageAction history, checked again at commit). |
| `assign_training` | allOf `modules.manage` (`PATCH /training/modules/:id`) | `trainingModule.service` `enrollStudentsInModule`: one `$addToSet` per student, never the PATCH full-roster replace | "Course assigned" in-app and email (type `course`) only to students this call actually added | People already on the course, with no Student profile, or with an inactive one are skipped (no profile is created). A replay adds and notifies nobody. |
| `send_course_reminder` | anyOf `modules.manage`, `students.manage` (without `modules.manage`, published courses only) | `trainingModule.service` `sendCourseReminder` | "Course reminder" in-app and email (type `course`); never says overdue (courses have no due date) | Only enrolled students who have not completed or dropped. Skips anyone reminded about that course in the last 24 h by anyone (`done` rows; at commit also rows still executing). |
| `create_task_plan` | allOf `projects.manage`, `tasks.manage` (the apply route); the PM service also requires project owner or admin | `pmAssistant.service` `applyTaskBreakdown` with the stored preview and the SageAction key as `idempotencyKey` | Nothing (creates unassigned tasks) | The preview (`previewTaskBreakdown`, one LLM call, `TaskBreakdownPreview` with a 24 h TTL) is the draft. `recheck` requires that preview to still be open, the same project and user, and unexpired; it never generates a second plan. A replay of the key returns the stored response. At most 60 tasks. |

People and documents are named one per entry, never a group ("everyone in a position"); a question
about the same data (who is enrolled, which documents are missing, is the interview scheduled) is a read
tool, not a draft. Assignment runs (the PM assistant's people-to-task matching) are out of scope.

## How to add a tool

This is the part that keeps adding the 41st tool as cheap as the 5th. Follow the
`jobs` domain (`agent/tools/jobs/`) as the reference.

### 1. Write the tool file

Create `agent/tools/<domain>/<name>.tool.js`:

```js
import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { MY_DOMAIN_ACCESS, myDomainScope } from './common.js';

export default defineTool({
  name: 'count_widgets',           // must match /^[a-z][a-z0-9_]{2,63}$/, unique across ALL domains
  domain: 'widgets',               // groups instructions + schemas; the unit find_tools loads (see "Lazy tool loading")
  kind: 'read',                    // 'read' runs in the loop; 'write' only drafts (see "How to add a write tool")
  description: 'Count widgets the user can see. Use for "how many widgets…".', // the MODEL reads this — be specific about when to call it
  input: Joi.object({
    filters: Joi.object({ search: Joi.string().min(1) }),
  }),
  // { anyOf: [...] } (>=1 permission string) or { note: '...' } when a handler
  // already enforces its own check (evaluated by toolAccess.js checkAccessRule).
  // Co-locate it as a constant in common.js (like jobs' JOBS_ACCESS) so every tool in
  // the domain shares one definition.
  access: MY_DOMAIN_ACCESS,
  async execute({ filters } = {}, ctx) {
    // ctx = { user, requestId, deps } — no chat objects (registry.js is chat-agnostic).
    const { Widget, visibilityFilter } = await myDomainScope(ctx);
    const match = { ...filters, ...visibilityFilter }; // AND the page's visibility filter — never trust filters alone
    return { total: await Widget.countDocuments(match) };
  },
  render(result) {
    // Optional. `facts.counts[]` entries are `{ kind, label, total }` — enforceCounts
    // rewrites every "N <label>" in the reply to `total`. Skip `facts` for a
    // per-group breakdown (rewriting each group's number to the overall total is wrong).
    return { blocks: [], facts: { counts: [{ kind: 'count_widgets', label: 'widgets', total: result.total }] } };
  },
});
```

Notes on each field, from what `defineTool.js` actually enforces (a bad tool throws at
**boot**, not mid-chat):
- **`input` (Joi) is the model-facing schema too.** `toJsonSchema.js` converts it once at
  load; it only supports the subset agent tools use — `object` (nested/required), `string`
  (`min`/`max`), `number`/`integer` (`min`/`max`), `boolean`, `array` (single item schema,
  `max`), `.valid(...)` as enum, `alternatives().try(...)` as `anyOf`, `.description()`,
  `.default()`, and a narrow `.allow(null)` on a plain-or-enum scalar. Anything else (`when`,
  pattern keys, unsupported rules) throws `Unsupported Joi feature '<x>' at <path>` — no
  silent drift between what Joi validates and what the model sees. String `.min()`/`.max()`
  are the only string transforms supported; don't reach for `.trim()`/`.lowercase()` etc.
  here — do that in `execute`.
- **Reuse a REST route's schema where one exists.** If the tool mirrors a portal GET page
  (e.g. jobs mirrors the ATS Jobs page), pull individual keys from that route's Joi object
  in `src/validations/*.validation.js` (see `agent/tools/jobs/filters.js`'s `page(key)`
  helper) so the chat accepts exactly what the page accepts. One source, no drift.
- **`access`** is `{ anyOf: [...] }`, `{ allOf: [...] }`, both, or `{ note: '...' }` (+ optional
  `rowScope: 'person'`), evaluated by `toolAccess.js`'s `checkAccessRule` (before the call) and
  `guardResultForRule` (row scope + salary redaction on the result). `anyOf` is OR
  (`requireAnyOfPermissions`); `allOf` is AND (`requirePermissions(a, b)`), each permission
  alias-resolved; with both, both must hold. Mirror an AND route with `allOf` — mapping it onto
  `anyOf` widens access.
- **`execute` must call the SERVICE layer**, not raw Mongo, when a service function exists —
  same business rules the REST controller uses.
- **`execute` must AND the page's visibility filter into every query**, and **must fail
  closed without a user id** — see `agent/tools/jobs/common.js`'s `jobScope(ctx)`: it throws
  if `ctx.user` has no id, because the visibility-filter builder returns `{}` (unrestricted)
  with no user id, and silently widening visibility on a missing id would be worse than
  erroring. New domains should follow the same `<domain>Scope(ctx)` pattern in their own
  `common.js`.
- **`render(result)` is optional.** Return `{ blocks, facts }` (facts optional). `facts.counts`
  entries are `{ kind, label, total }`. The multi-count merge rule (`runAgent.js`'s
  `mergeCountFacts`): when several tool calls in one turn report the same `label` (or the
  same `role`, if the fact carries one) with **different** totals — "9 internships, 4
  contract jobs" — neither gets enforced, because rewriting both "N `<label>`" phrases to a
  single total would corrupt one of them. Only give a fact the same label/role as another
  call in the turn when they really should share one number.
- **`timeoutMs` is optional.** An integer from 1 to 15000 (kept under
  `CHATBOT_AGENT_STEP_TIMEOUT_MS`, 20000); `registry.execute` uses `tool.timeoutMs ??
  config.chatbot.agent.toolTimeoutMs`. Only composite tools that run several others need it.

### Composite tools (`compose.js`)

A tool that answers from other tools calls them through `agent/compose.js`, never by writing a
new unscoped query. `runTool(name, args, ctx, { timeoutMs = 6000 })` runs a registered tool exactly
as the registry would for `ctx.user`: access check, write refusal, Joi validation, timeout and
`guardResultForRule`. It never throws; it returns `{ status: 'ok', result }` or `restricted` /
`invalid` / `timeout` / `error` / `unknown`, and the composite reports that status per section
(never filling a restricted or failed section from elsewhere). `runTools(calls, ctx)` runs
independent sections in parallel. `ctx.composeDepth` allows a composite to call another composite
once (depth 2); a third level returns `error`, so tools cannot loop. Give the composite its own
`access: { note }` (sections gate themselves) and a `timeoutMs` that covers its slowest section.

### How to add a write tool

A write tool never writes from the chat loop. The model drafts; the user presses Confirm;
the confirm endpoint performs the write (`agent/sageActions.js`, model `SageAction`).

```js
export default defineTool({
  name: 'close_jobs',
  domain: 'jobs',
  kind: 'write',
  description: 'Draft closing jobs. Only drafts: the user must press Confirm.',
  input: Joi.object({ jobIds: Joi.array().items(Joi.string()).min(1).max(50).required() }),
  access: { allOf: ['jobs.read', 'jobs.manage'] }, // mirror the write route's own gate
  // maxTargets: 20,                // optional, default and ceiling 50
  async prepare({ jobIds }, ctx) {
    // READ-ONLY. Resolve targets under the caller's row scope and validate.
    return {
      ok: true,
      summary: {
        title: 'Close 2 jobs',
        lines: ['Close "React Developer"', 'Close "QA Lead"'],
        targetCount: 2,
        targets: [{ id: 'j1', name: 'React Developer' }, { id: 'j2', name: 'QA Lead' }], // every target
        confirmLabel: 'Close jobs', // optional, default 'Confirm'
      },
      payload: { jobIds: ['j1', 'j2'] }, // what commit needs: ids, not names
    }; // or { ok: false, error: 'No open jobs match.' }
  },
  async commit(draft, ctx) {
    // Performs the write from draft.payload through the service layer.
    return { ok: true, message: 'Closed 2 jobs.', details: { closed: 2 } };
  },
  // Optional. When present, confirm calls this INSTEAD of re-running prepare.
  // async recheck(draft, ctx) { return { ok: true }; } // or { ok: false, error }
});
```

- **`prepare(value, ctx)`** is read-only and runs under the tool timeout, both when the model
  drafts and (by default) again on confirm. `summary.targets` must list every target
  (`targets.length === targetCount`, at most `maxTargets`, ceiling 50), or the draft is refused.
- **`commit(draft, ctx)`** gets `{ key, tool, args, summary, payload }` and returns
  `{ ok, message, details? }`. It runs with no timeout: a timeout would not stop the write
  underneath, so the row would say failed while the write still lands.
- **`recheck(draft, ctx)`** (optional) replaces the default confirm check, which re-runs
  `prepare` and refuses unless the fresh target ids equal the draft's. Use it when prepare's
  output must not be regenerated on confirm (e.g. a generated task-plan preview); check that
  the stored payload is still valid and return `{ ok: true }` or `{ ok: false, error }`.
- **Defined with `execute` instead of `prepare`/`commit`, it throws at load.** Write tools get
  no `rowScope` result guard and no `render`: prepare scopes itself, and the registry renders
  the confirm block.
- **Confirm block** (`renderers/types.js` `ConfirmBlock`):
  `{ type: 'confirm', key, title, lines, targetCount, confirmLabel, expiresAt }`. `runAgent`
  appends every confirm block after the turn's other blocks, so a later list render never
  replaces it. Clients that don't know the type drop it.

**`POST /v1/chat-assistant/actions/:key/confirm`** (auth, `chatAssistantLimiter`, key = uuid):
1. Impersonating → 403 "Actions are disabled while impersonating".
2. Atomic claim `{ key, userId, status: 'pending', expiresAt > now }` → `executing`. No row:
   another user's key or missing → 404; expired → 410 (row marked `expired`); already
   done / failed / executing / cancelled → 409 with the stored result. Nothing runs twice.
3. Re-check: access rule (permissions may have changed → 403), Joi-validate the stored args,
   then `recheck` if defined, else re-run `prepare`; different target ids → 409 "The data
   changed since the draft — ask Sage again." (row failed).
4. `commit` → result stored, status `done` / `failed`, `expiresAt` bumped to +24 h. A commit
   that returns `ok: false` answers 200 with `status: 'failed'`; a thrown error answers 500
   `{ status: 'failed', message }` and the row is never left `executing`.
5. One activity log row per claimed confirm: `sage.action.confirmed` or `sage.action.failed`,
   entity `SageAction` / key, metadata `{ source: 'sage', tool, targetCount, targetIds (≤ 50),
   outcome }`.
6. Responds `{ status, message, details? }`.

**`POST /v1/chat-assistant/actions/:key/cancel`** — pending → `cancelled` (same ownership
rules, 404 for someone else's key); cancelling again returns 200; a finished action is 409.

**Lifetimes and failure modes.** A draft is valid for 15 minutes; terminal rows stay 24 hours,
then the `{ expiresAt: 1 }` TTL index removes them (so an expired draft answers 404 once the
TTL monitor has deleted it). A process crash mid-commit leaves the row `executing`; it expires
with the draft's TTL and a later confirm reports not found, so the outcome is unknown —
acceptable today; the upgrade is a sweeper. Indexes `{ key: 1 }` unique and `{ expiresAt: 1 }`
TTL are not built in production (`autoIndex: false`): create them on deploy.

### 2. Register it

Add the tool to its domain's `agent/tools/<domain>/index.js`:

```js
export default {
  domain: 'widgets',
  summary: 'Widgets on the Widgets page: counts and lists.', // find_tools catalog line
  instructions: '<plain-text guidance for this domain>',
  tools: [countWidgets],
};
```

`summary` is required: one line of at most 120 characters. It is the domain's line in the
`find_tools` catalog — all the model sees of a domain it has not loaded yet — so name what the
domain answers, not how. `getAgentTools` (and module load) throws if a domain has none
(`assertDomainSummaries`).

New domain → add one line to `agent/tools/index.js`'s array (see how it already lists `jobs`).

### 3. Add an eval case

`agent/__evals__/cases.json` holds question → expected tool + key args pairs, one array of
cases like:

```json
{ "id": "count-widgets-plain", "question": "how many widgets are there?",
  "expect": { "tools": ["count_widgets"], "args": { "count_widgets": { "filters": { "search": "widgets" } } } } }
```

`scripts/sage-agent-evals.js` (`npm run eval:sage-agent`) runs these against the **live**
model with the real registry and real loop, but fake tool executors (no DB), and reports
tool-pick accuracy + latency. Add at least one case for every new tool. Run it before
merging tool changes — it costs real tokens, so it isn't in unit test CI.

`expect.tools` is the exact set of tool names expected (order-independent, one call per
tool). By default a case fails if the actual call count exceeds `expect.tools.length` —
add an optional `expect.maxCalls` to raise that ceiling for a case that legitimately needs
more calls than distinct tools (e.g. two calls to `count_jobs` to compare two filters):

```json
{ "id": "compare-two-searches", "question": "how many react jobs vs how many vue jobs?",
  "expect": { "tools": ["count_jobs"], "maxCalls": 2 } }
```

### 4. Register the test file (3-step trap)

A new `*.test.js` under `agent/__tests__/` or `agent/tools/<domain>/__tests__/` is already
covered by `package.json`'s `test:entity-query` glob (`agent/__tests__/*.test.js` and
`agent/tools/*/__tests__/*.test.js`) — but it still needs to be committed, which this repo's
tooling only does for files explicitly allow-listed:
1. Add a `!` line for the new test file (and its `__tests__/` dir, if new) to `.gitignore`
   under the "Sage agent loop" section.
2. Add its path to `scripts/test-manifest.json`.
3. Confirm it's under one of the two globs above in `package.json` (`test:entity-query`) —
   new domain directories already match `agent/tools/*/__tests__/*.test.js`.

See memory `project_backend_tests_not_versioned` for why this is 3 steps, not 1.

## Rules that keep it safe

- **RBAC is checked twice.** `getAgentTools` hides tools the user can't call (the model
  never sees them); `registry.execute` re-checks access on every call regardless, because
  the model can still name a tool it was never shown.
- **Numbers only come from this turn's tools.** `runAgent` merges `render()`'s `facts` and
  runs `enforceCounts` on the final text, which rewrites a count that disagrees with a
  tool's total. That only covers counts a tool reported: it cannot check a number when no
  tool ran. So a reply containing any digit with **no successful tool call** this turn is
  not shipped — `runAgent` returns `null` (outcome `untooled_number`) and the user gets the
  fixed "won't guess a number" reply. Digit-free no-tool replies (e.g. defining "MERN") still ship; keeping
  those from being company facts rests on `BASE_INSTRUCTIONS` (company policies, people and
  data → tool or `handoff`).
- **Turns are time-boxed.** Each model step has a per-request timeout
  (`CHATBOT_AGENT_STEP_TIMEOUT_MS`, SDK retries off) and the turn has a deadline
  (`CHATBOT_AGENT_TURN_TIMEOUT_MS`); each step gets at most the time left. Past the deadline
  `runAgent` returns `null` (outcome `deadline`) and the user gets the fixed "couldn't answer
  right now" reply.
- **Results are size-capped, but only at the top level.** The registry's `shrinkToFit`
  (`MAX_RESULT_CHARS = 20000`) only shrinks the largest top-level **array** property,
  tagging `truncated: true`. A single large scalar field (e.g. `get_job`'s job description)
  is not touched by that cap — bound it yourself in the tool, the way `get_job.tool.js`'s
  `boundDescription` truncates at `MAX_DESCRIPTION_CHARS`.
- **Write tools only draft; the user's confirm performs the write.** For a `kind: 'write'`
  tool, `registry.execute` runs the access check, Joi validation and the tool's read-only
  `prepare` under the timeout, stores a pending `SageAction` and returns
  `{ draft: true, key, summary, expiresAt }` to the model plus a `confirm` block. The model
  has no confirm tool; `BASE_INSTRUCTIONS` tells it a write tool only drafts and never to say
  it is done. The write happens only in `POST /v1/chat-assistant/actions/:key/confirm`
  (see "How to add a write tool"). Composite tools never draft: `compose.runTool` refuses
  every write tool. Drafting is refused while impersonating.
- **Agent failure never means a dead chat.** Handoff, a thrown error, or the same tool
  failing twice in one turn all make `runAgent` return `null` immediately. An empty final
  reply gets one retry first — `runAgent.js` re-asks with `tool_choice:'none'` on the same
  input — and only returns `null` if that retry is *also* empty. Either way `tryAgentTurn`
  sends a fixed reply (request flow, step 5) and never throws.
- **Per-step tool-call cap.** `runAgent.js`'s `MAX_CALLS_PER_STEP = 8`: the model can emit
  dozens of parallel calls in one step when its tools don't fit the question, so only the
  first 8 actually run; the rest get a `{"error":"too many calls in one step"}` output so
  every call still has a matching result and the model sees the cap was hit.
- **Boot fails on a dangling follow-up tool.** Person-profile providers list `relatedTools`
  (`personProfile/providers/*.js`) that `get_user` results point the model to;
  `toolRegistry.js` runs `assertRelatedToolsExist` at load, so naming a tool the agent
  does not have fails at boot, not mid-chat.

## Context & memory

Per-step model input is `[stable prefix] + [turn context] + [history] + [this turn's tool items]`:

- **Stable prefix** — `runAgent.BASE_INSTRUCTIONS` + the permitted domains' `instructions`
  + sorted tool schemas (lazy mode: `LAZY_INSTRUCTIONS` + `handoff` / `find_tools`) — passed as
  `instructions` to `llm.step`. It must stay identical
  across users and turns so OpenAI's prompt cache hits; **never put per-user or time-varying
  data here** (that's what turn context is for).
- **Turn context** — one `developer`-role message built by `context.js`'s
  `buildAgentInput`: today's date/timezone, the user's name and resolved role names, and
  (if any) a "Previous tool calls" section rendered from the ledger.
- **History** — the last 6 turns of user/assistant text from the request's `messages`
  (`context.js`'s `trimToLastTurns`).
- **Tool ledger** — every agent turn's successful tool calls are summarized
  (`summarizeCalls`) and appended to `ConversationMemory.agentLedger`, capped to the last 6
  entries (`appendAgentLedger`). Turns with no tool calls append nothing (older rows may
  still hold `{ at, handoff: true }` markers from the removed recency window; they carry no
  `calls` and are skipped on replay). This is how a bare follow-up ("what about ai?") gets
  resolved: the model sees `count_jobs({"search":"ml"}) → total 12` in turn context and
  re-calls with changed args — it never reuses a stale number from the ledger itself
  (`BASE_INSTRUCTIONS` says so explicitly).
- **This turn's tool items** grow within the loop (function calls + outputs). If the
  running input passes `CHATBOT_AGENT_INPUT_BUDGET` characters, `compactTurnItems` replaces
  the **oldest** `function_call_output`s with a short `{tool} → total {N}` summary first,
  never dropping or reordering items.

## Config

All read from `src/config/config.js` (`config.chatbot` / `config.chatbot.agent`):

| Env var | Config path | Default | Meaning |
|---|---|---|---|
| `CHATBOT_MODEL` | `chatbot.model` | *(required, no default)* | OpenAI model for Sage's agent loop. Every environment must set it. |
| `CHATBOT_REASONING_EFFORT` | `chatbot.reasoningEffort` | `none` | Reasoning effort for the agent loop's model calls (reasoning models only). |
| `CHATBOT_AGENT_MAX_STEPS` | `chatbot.agent.maxSteps` | `5` | Max tool-call steps per agent turn before it's forced to answer with `tool_choice: 'none'`. |
| `CHATBOT_AGENT_TOOL_TIMEOUT_MS` | `chatbot.agent.toolTimeoutMs` | `8000` | Per-tool-call timeout in the registry; `0` disables the timeout. |
| `CHATBOT_AGENT_STEP_TIMEOUT_MS` | `chatbot.agent.stepTimeoutMs` | `20000` | Per-request timeout for one model step (`responses.create`), with SDK retries disabled. A timeout is a thrown error → the fixed "couldn't answer right now" reply. |
| `CHATBOT_AGENT_TURN_TIMEOUT_MS` | `chatbot.agent.turnTimeoutMs` | `30000` | Deadline for the whole agent turn. Checked before each step, and each step's timeout is capped to the time left; past it the user gets the fixed "couldn't answer right now" reply. |
| `CHATBOT_AGENT_INPUT_BUDGET` | `chatbot.agent.inputBudget` | `60000` | Max characters of this-turn tool items before `compactTurnItems` starts summarizing the oldest ones; `0` disables the budget. |

`CHATBOT_AGENT` and `CHATBOT_TWO_STAGE` are gone (R9). The config schema allows unknown keys, so a
host `.env` that still sets them boots fine; they are simply ignored and can be deleted.

## Deploy notes

- These vars are read from **each EC2 host's own `.env`** — staging (`dharwin/dev`) and
  production (`dharwin/main`) are separate hosts reading their own gitignored `.env`, and a
  branch merge runs nothing on either. `CHATBOT_MODEL` is required; the rest have defaults.
- Since R9 the agent is the only path on every host, whatever `CHATBOT_AGENT` says: a host
  that had it unset or `false` switches from the legacy pipeline to the agent on its next
  pull + restart.
- `ConversationMemory` keeps `agentLedger` (the tool ledger), `expiresAt` (30-day TTL, set
  when the row is created) and, only so `entityCleanup.js` / `memorySweep.scheduler.js` can
  scrub deleted people/roles/jobs out of rows written before R9, the `lastEntities` identity
  pointers and `lastListing`. Every other legacy field (`summary`, `turnCount`, pending picks,
  query contexts, `conversationTopic`, …) was dropped from the schema with no migration; old
  documents carry the extra keys until the TTL removes them.

## Known limits / upgrade paths

- **Tool-count ceiling.** `find_tools` is built (see "Lazy tool loading"): above 30 permitted
  tools the model loads domains on demand. Its own ceiling is the catalog, one line per domain
  in every lazy prompt; the upgrade is nested domains or embedding-based tool search. Loading a
  domain changes the tool list mid-turn; the Responses API's
  `tool_choice: { type: 'allowed_tools' }` (supported by our model, checked 2026-09-28) could
  instead keep the full list in the cached prefix and narrow the active set per step.
- **No token streaming.** `llm.step` returns the complete `output_text` once the Responses API
  call resolves, so the stream route sends the reply as a single `{ token }` event before
  `{ done }`. Streaming the final step would need `responses.create({ stream: true })` in
  `llm.step` and forwarding its text deltas through `onToken`.
- **A handoff is a dead end for the user.** With no legacy pipeline behind it, a question no
  tool covers (e.g. system email delivery logs) gets the fixed "I don't have that in the system" reply. Coverage grows by adding tools.
- **`meta.kind` is always `'jobs'` on an answered turn** — the value the agent path sent since
  the jobs-only first round. The frontend stores it but does not branch on it; derive it from
  the turn's tool domains if something ever needs it to be right.
- **Ledger TTL.** `appendAgentLedger` does not slide `expiresAt`, so a row (and its ledger)
  expires 30 days after it was created even for an active user; the next turn starts a fresh
  row. At most one follow-up per month loses its "Previous tool calls" context.
