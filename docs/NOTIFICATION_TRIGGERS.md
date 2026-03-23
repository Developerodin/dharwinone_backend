# In-app notification triggers

Persistent notifications live in MongoDB (`Notification`). Code entry points are in `src/services/notification.service.js` (`notify`, `notifyByEmail`, `createNotification`). Real-time unread updates use SSE from the same service.

When adding a trigger: update this file, `notification.model.js` `type` enum, frontend `NotificationType` (`uat.dharwin.frontend/shared/lib/api/notifications.ts`), header + notifications page + dashboard icon maps, and (if emails use prefs) `NOTIFICATION_TYPE_TO_PREF_KEY` + user `notificationPreferences` + Settings UI.

## Preference keys (email)

`NOTIFICATION_TYPE_TO_PREF_KEY` in `notification.service.js` maps `type` → `User.notificationPreferences` field. Types **not** in that map still send email when an `email` payload is provided (no opt-out in Settings for that category).

| `type` | Email pref key (`notificationPreferences`) |
|--------|---------------------------------------------|
| `leave` | `leaveUpdates` |
| `task` | `taskAssignments` |
| `job_application` | `applicationUpdates` |
| `offer` | `offerUpdates` |
| `meeting` | `meetingInvitations` |
| `meeting_reminder` | `meetingReminders` |
| `certificate` | `certificates` |
| `course` | `courseUpdates` |
| `recruiter` | `recruiterUpdates` |
| `assignment`, `account`, `project`, `general` | _(none — email allowed if caller sends `email`)_ |

## Trigger inventory

| Trigger | Entry | Method | `type` | Recipients | In-app if no User? | Idempotency / notes |
|--------|--------|--------|--------|------------|--------------------|---------------------|
| Task assigned (create) | `task.service.js` `createTask` | `notify` | `task` | Each assignee (≠ creator) | N/A | Assignee user IDs deduped before loop |
| Task assigned (update) | `task.service.js` `updateTaskById` | `notify` | `task` | Newly assigned users | N/A | Deduped assignee IDs |
| Task status changed | `task.service.js` `updateTaskStatusById` | `notify` | `task` | Creator (if not actor) + assignees (excl. actor/creator dup) | N/A | Assignee IDs deduped |
| Project assigned (create) | `project.service.js` `createProject` | `notify` | `project` | Each `assignedTo` user | N/A | User IDs deduped |
| Project assigned (update) | `project.service.js` `updateProjectById` | `notify` | `project` | New assignees only | N/A | Added user IDs deduped |
| Offer sent | `offer.service.js` `updateOfferById` | `notifyByEmail` | `offer` | Candidate email → user | No in-app | Optional `email` payload + prefs |
| Offer accepted/rejected | `offer.service.js` | `notify` | `offer` | Offer creator | N/A | Optional `email` + prefs |
| Job application status | `jobApplication.service.js` | `notifyByEmail` | `job_application` | Candidate email → user | No in-app | Optional `email` + prefs |
| Meeting invite / resend | `meeting.service.js` | `notifyByEmail` | `meeting` | Each invite email (deduped set) | No in-app | Emails from `getInvitationEmails` (unique) |
| Meeting reminder (~15m) | `meeting.service.js` `sendUpcomingMeetingReminders` | `notify` | `meeting_reminder` | Users matching invite emails | N/A | In-memory `meetingReminderSentIds` per process |
| Leave approved/rejected | `leaveRequest.service.js` | `notifyByEmail` | `leave` | `studentEmail` → user | No in-app | Optional `email` + prefs |
| Backdated attendance approved/rejected | `backdatedAttendanceRequest.service.js` | `notifyByEmail` | `leave` | Requester email → user | No in-app | Optional `email` + prefs |
| Course student/mentor changes | `trainingModule.service.js` `updateTrainingModuleById` | `notify` | `course` | Affected student/mentor users | N/A | One notify per added/removed id |
| Certificate issued | `certificate.service.js` | `notify` | `certificate` | Student’s user | N/A | Optional `email` + prefs |
| Recruiter assigned | `candidate.service.js` `assignRecruiterToCandidate` | `notify` | `recruiter` | Recruiter user | N/A | Optional `email` + prefs |
| Agent assigned | `candidate.service.js` | `notify` | `assignment` | Agent user | N/A | No email pref key |
| Account activated | `user.service.js` `updateUserById` | `notify` | `account` | Activated user | N/A | In-app only (no `email` block) |
| Resign / joining scheduler | `candidate.scheduler.js` | `notify` / `notifyByEmail` | `account` | Admin + candidate | Candidate needs User for in-app | Fire-and-forget |
| Job share | `job.controller.js` `shareJobEmail` | `notifyByEmail` | `general` | `to` if user exists | No in-app | Template email separate |
| Candidate invite | `auth.controller.js` | `notifyByEmail` | `general` | Invitee | No in-app | Bulk array; invitation email separate |
| Candidate profile share | `candidate.controller.js` | `notifyByEmail` | `general` | Recipient | No in-app | Share email separate |
| Post-call (Bolna) | `bolna.controller.js` `sendPostCallEmailAndNotification` | `createNotification` | `general` | User matching candidate email | No in-app | **`CallRecord.postCallFollowUpSent`** claim + rollback on failure |

## Webhooks and duplicates

Bolna (and similar) may deliver **at-least-once**. Post-call follow-up uses an atomic claim on `CallRecord` so the same `executionId` does not send duplicate email + notification after a successful claim.

## Related doc

- [EMAIL_NOTIFICATIONS.md](./EMAIL_NOTIFICATIONS.md) — SMTP templates and transactional email list
