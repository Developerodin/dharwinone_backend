/**
 * How each Postman API connects to the Dharwin mobile app (Expo Router).
 * Repo: Dharwin App/my-app
 */

export const APP_NAV_OVERVIEW = `
### App navigation map

\`\`\`
app/index.tsx (splash)
  └─► app/login.tsx ──► Auth APIs ──► app/(tabs)/*
        app/forgot-password.tsx

app/(tabs)/_layout.tsx  — 5 tabs (left → right):
  1. Mails      app/(tabs)/mails.tsx
  2. Chats      app/(tabs)/chats.tsx
  3. Calls      app/(tabs)/calls.tsx
  4. Meetings   app/(tabs)/meetings.tsx
  5. Files      app/(tabs)/files.tsx
\`\`\`

**Wiring status:** Most screens still use mock data. \`services/mail.ts\` + \`services/api.ts\` exist; auth/meetings/chats/files/calls services are planned.

| Area | Tab / entry | Inner screens |
|------|-------------|---------------|
| Auth | \`/login\` | \`/forgot-password\` |
| Mails | \`/(tabs)/mails\` | \`/mail/[folder]\`, \`/mail/thread/[id]\`, \`/mail/compose\`, \`/mail/accounts\`, \`/mail/add-account\`, \`/mail/settings\`, \`/mail/create-label\` |
| Chats | \`/(tabs)/chats\` | \`/chat/[id]\`, \`/chat/new\` |
| Calls | \`/(tabs)/calls\` | \`/call/new\` |
| Meetings | \`/(tabs)/meetings\` | \`/meeting/[id]\`, \`/meeting/create\` |
| Files | \`/(tabs)/files\` | \`/files/category/[id]\`, \`/files/[id]\`, \`/files/upload\` |
`.trim();

/** Per-folder screen tree (shown in folder description). */
export const FOLDER_SCREEN_TREE = {
  '1. Auth': `
**Login & session (pre-tabs)**
- \`app/index.tsx\` → splash → navigates to \`/login\`
- \`app/login.tsx\` (\`/login\`) → **Login**, then **Me** → enter tabs
- \`app/forgot-password.tsx\` → UI only (no Postman API yet)
- \`services/api.ts\` → **Refresh Tokens** on 401 (interceptor, planned)
- \`app/mail/accounts.tsx\` → **Logout** on sign-out
`.trim(),
  '2. Mail - Gmail': `
**Tab:** \`app/(tabs)/mails.tsx\` → account switcher, recent threads

**Inner screens**
| Route | File | APIs to wire |
|-------|------|--------------|
| \`/mail/[folder]\` | \`app/mail/[folder].tsx\` | List Threads, Labels |
| \`/mail/thread/[id]\` | \`app/mail/thread/[id].tsx\` | Thread Detail, Single Message, Patch, Trash, Attachment |
| \`/mail/compose\` | \`app/mail/compose.tsx\` | Send, Reply, Reply All, Forward, AI Draft, Templates |
| \`/mail/accounts\` | \`app/mail/accounts.tsx\` | GET Accounts |
| \`/mail/add-account\` | \`app/mail/add-account.tsx\` | OAuth Start/Callback, DELETE Account |
| \`/mail/settings\` | \`app/mail/settings.tsx\` | Signature Get/Patch |
| \`/mail/create-label\` | \`app/mail/create-label.tsx\` | Labels (create) |

**Service:** \`services/mail.ts\` (provider \`gmail\` → \`/email/*\`)
`.trim(),
  '3. Mail - Outlook': `
Same UI as Gmail — pass \`provider: 'outlook'\` in \`services/mail.ts\` (\`/outlook/*\`).

Screens: identical to folder 2 (accounts, add-account, mails tab, folders, thread, compose).
`.trim(),
  '4. Internal Meetings': `
**Tab:** \`app/(tabs)/meetings.tsx\` → Upcoming / Completed / Cancelled segments

**Inner screens**
| Route | File | APIs to wire |
|-------|------|--------------|
| \`/meeting/[id]\` | \`app/meeting/[id].tsx\` | Detail, Recordings, Cancel, LiveKit token |
| \`/meeting/create\` | \`app/meeting/create.tsx\` | Create, Patch / Reschedule |

**Service:** \`services/meetings.ts\` (planned)
`.trim(),
  '5. LiveKit': `
Called from meeting and chat flows (not a separate tab).

| Trigger screen | When |
|----------------|------|
| \`app/meeting/[id].tsx\` | User taps **Join Meeting** |
| \`app/chat/[id].tsx\`, \`app/call/new.tsx\` | Start audio/video call |

**Service:** \`services/livekit.ts\` (planned)
`.trim(),
  '6. Recordings (Global)': `
Used from \`app/meeting/[id].tsx\` recording section (playback + transcript).

**Service:** \`services/recordings.ts\` (planned)
`.trim(),
  '7. File Storage': `
**Tab:** \`app/(tabs)/files.tsx\` → categories + recent files

**Inner screens**
| Route | File | APIs to wire |
|-------|------|--------------|
| \`/files/category/[id]\` | \`app/files/category/[id].tsx\` | List (with prefix) |
| \`/files/[id]\` | \`app/files/[id].tsx\` | Download, Delete |
| \`/files/upload\` | \`app/files/upload.tsx\` | Upload |

**Service:** \`services/files.ts\` (planned)
`.trim(),
  '8. Chats': `
**Tab:** \`app/(tabs)/chats.tsx\` → conversation list

**Inner screens**
| Route | File | APIs to wire |
|-------|------|--------------|
| \`/chat/[id]\` | \`app/chat/[id].tsx\` | Messages, Send, Upload, Mark Read, Start Call |
| \`/chat/new\` | \`app/chat/new.tsx\` | User Search → open new chat |

**Realtime:** **Socket Token** on app bootstrap (\`services/chat.ts\`, planned)
`.trim(),
  '9. Unified Calls': `
**Tab:** \`app/(tabs)/calls.tsx\` → unified call history (telephony + in-app)

Also uses **In-App Calls List** from folder 8 for chat-scoped history.

**Inner:** \`app/call/new.tsx\` → User Search + LiveKit token (folder 5)
`.trim(),
};

/** folder → requestName → connection details */
export const APP_CONNECTION_BY_FOLDER = {
  '1. Auth': {
    Login: {
      route: '/login',
      file: 'app/login.tsx',
      service: 'services/auth.ts (planned)',
      when: 'User taps **Sign in** after entering email + password',
      flow: 'index (splash) → login → **Login** → store tokens → **Me** → router.replace("/(tabs)/…")',
      from: 'app/index.tsx',
      to: 'app/(tabs)/*',
      status: 'Not wired — mock navigates to /chats without API',
    },
    'Me (current user)': {
      route: '/ (bootstrap) or tabs',
      file: 'app/_layout.tsx / services/api.ts (planned)',
      service: 'services/auth.ts → getMe()',
      when: 'Immediately after Login; also on cold start if refresh token valid',
      flow: 'Login success → **Me** → hydrate user, roles, feature flags → render tabs',
      from: 'login.tsx or app bootstrap',
      to: 'All tabs (permission-gated UI)',
      status: 'Not wired',
    },
    'Refresh Tokens': {
      route: '(global)',
      file: 'services/api.ts',
      service: 'services/api.ts — axios/fetch interceptor',
      when: 'Any API returns 401; before retrying the failed request',
      flow: 'API 401 → **Refresh Tokens** → update accessToken → retry original call',
      from: 'Any authenticated screen',
      to: 'Same screen (transparent retry)',
      status: 'Not wired',
    },
    Logout: {
      route: '/mail/accounts',
      file: 'app/mail/accounts.tsx',
      service: 'services/auth.ts → logout()',
      when: 'User taps **Sign out** on accounts screen',
      flow: 'accounts → **Logout** → clear secure storage → router.replace("/login")',
      from: 'mail/accounts (also reachable from mails tab sidebar)',
      to: 'app/login.tsx',
      status: 'Not wired',
    },
  },
  '2. Mail - Gmail': {
    'GET Accounts': {
      route: '/(tabs)/mails | /mail/accounts',
      file: 'app/(tabs)/mails.tsx, app/mail/accounts.tsx',
      service: 'services/mail.ts → listAccounts("gmail")',
      when: 'Mails tab mount; accounts screen open; after OAuth connect',
      flow: 'Tab load → **GET Accounts** → populate switcher → save accountId',
      from: 'Tab bar Mails',
      to: 'mail/[folder], thread, compose',
      status: 'Service ready; screens use mock',
    },
    'OAuth - Start Google': {
      route: '/mail/add-account',
      file: 'app/mail/add-account.tsx',
      service: 'services/mail.ts → getOAuthUrl("gmail")',
      when: 'User taps **Connect Gmail**',
      flow: 'add-account → **OAuth Start** → open browser URL → user consents',
      from: 'mail/accounts or sidebar',
      to: 'OAuth callback deep link',
      status: 'Service ready; deep link handler not built',
    },
    'OAuth - Google Callback': {
      route: 'dharwin://oauth/google (planned)',
      file: 'app/_layout.tsx deep-link handler (planned)',
      service: 'Handled server-side; app receives redirect',
      when: 'After Google redirects back to app',
      flow: 'Browser callback → backend stores tokens → deep link → **GET Accounts**',
      from: 'External browser',
      to: 'mail/add-account or mails tab',
      status: 'Not implemented',
    },
    'DELETE Account': {
      route: '/mail/add-account',
      file: 'app/mail/add-account.tsx',
      service: 'services/mail.ts → revokeAccount("gmail", id)',
      when: 'User revokes/disconnects a Gmail account',
      flow: 'add-account → confirm → **DELETE Account** → refresh list',
      from: 'mail/accounts, add-account',
      to: 'Same screen (updated list)',
      status: 'Service ready; UI mock',
    },
    'List Threads': {
      route: '/(tabs)/mails | /mail/[folder]',
      file: 'app/(tabs)/mails.tsx, app/mail/[folder].tsx',
      service: 'services/mail.ts → listThreads("gmail", { accountId, labelId, q })',
      when: 'Tab/folder mount, pull-to-refresh, search, infinite scroll',
      flow: 'Select account + folder → **List Threads** → render rows',
      from: 'Mails tab, sidebar folder tap',
      to: 'mail/thread/[id]',
      status: 'Service ready; screens use mock',
    },
    'Thread Detail': {
      route: '/mail/thread/[id]',
      file: 'app/mail/thread/[id].tsx',
      service: 'services/mail.ts → getThread("gmail", accountId, threadId)',
      when: 'User opens a thread from list',
      flow: 'Tap thread row → **Thread Detail** → render messages',
      from: 'mails tab, mail/[folder]',
      to: 'mail/compose?mode=reply',
      status: 'Mock data (getMailThreadDetail)',
    },
    'Single Message': {
      route: '/mail/thread/[id]',
      file: 'app/mail/thread/[id].tsx',
      service: 'services/mail.ts → getMessage("gmail", accountId, messageId)',
      when: 'Expand single message or load body on demand',
      flow: 'Inside thread → **Single Message** for full HTML body',
      from: 'thread/[id]',
      to: 'Same screen',
      status: 'Mock / planned lazy load',
    },
    'Send Message': {
      route: '/mail/compose',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → sendMessage("gmail", payload)',
      when: 'User taps **Send** on new compose',
      flow: 'compose (new) → **Send Message** → pop to folder/inbox',
      from: 'mails FAB, folder, thread forward',
      to: 'mail/[folder] or mails tab',
      status: 'UI preview alert only',
    },
    Reply: {
      route: '/mail/compose?mode=reply',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → reply("gmail", messageId, payload)',
      when: 'Send on reply compose',
      flow: 'thread → Reply → compose → **Reply** → back to thread',
      from: 'mail/thread/[id]',
      to: 'mail/thread/[id]',
      status: 'Not wired',
    },
    'Reply All': {
      route: '/mail/compose?mode=replyAll',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → replyAll(...)',
      when: 'Send on reply-all compose',
      flow: 'thread → Reply All → compose → **Reply All**',
      from: 'mail/thread/[id]',
      to: 'mail/thread/[id]',
      status: 'Not wired',
    },
    Forward: {
      route: '/mail/compose?mode=forward',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → forward(...)',
      when: 'Send on forward compose',
      flow: 'thread → Forward → compose → **Forward**',
      from: 'mail/thread/[id]',
      to: 'mail/[folder]',
      status: 'Not wired',
    },
    'Patch Message (labels/read)': {
      route: '/mail/thread/[id]',
      file: 'app/mail/thread/[id].tsx',
      service: 'services/mail.ts → modifyMessage(...)',
      when: 'Star, mark read/unread, archive from thread toolbar',
      flow: 'Thread action → **Patch Message** → update local state',
      from: 'mail/thread/[id]',
      to: 'Same thread',
      status: 'Not wired',
    },
    'Batch Modify Messages': {
      route: '(none)',
      file: '—',
      service: 'services/mail.ts → batchModifyMessages(...)',
      when: 'Future bulk select in folder view',
      flow: 'Select multiple → **Batch Modify**',
      from: 'mail/[folder] (planned)',
      to: 'Folder list refresh',
      status: 'No mobile UI',
    },
    'Trash Thread': {
      route: '/mail/thread/[id]',
      file: 'app/mail/thread/[id].tsx',
      service: 'services/mail.ts → trashThreads(...)',
      when: 'User deletes/moves thread to trash',
      flow: 'Thread → Delete → **Trash Thread** → router.back()',
      from: 'mail/thread/[id]',
      to: 'Previous folder',
      status: 'Not wired',
    },
    'Get Attachment': {
      route: '/mail/thread/[id]',
      file: 'app/mail/thread/[id].tsx',
      service: 'services/mail.ts (add getAttachment — planned)',
      when: 'User taps attachment chip',
      flow: 'Thread → attachment → **Get Attachment** → open/share file',
      from: 'mail/thread/[id]',
      to: 'OS share sheet / viewer',
      status: 'Not wired',
    },
    Labels: {
      route: '/mail/[folder] + sidebar',
      file: 'components/mail-sidebar.tsx, app/mail/[folder].tsx',
      service: 'services/mail.ts → listLabels("gmail")',
      when: 'Mails tab load; sidebar open; before folder-specific List Threads',
      flow: '**Labels** → build sidebar → tap folder → List Threads with labelId',
      from: '(tabs)/mails',
      to: 'mail/[folder]',
      status: 'Service ready; sidebar uses static folders',
    },
    'Templates - List': {
      route: '/mail/compose',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → listTemplates()',
      when: 'User opens template picker (UI not built)',
      flow: 'Compose → Templates → **List**',
      from: 'mail/compose',
      to: 'Compose body filled',
      status: 'No UI',
    },
    'Templates - Create': {
      route: '/mail/compose',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → createTemplate()',
      when: 'Save current compose as template (planned)',
      flow: 'Compose → Save as template → **Create**',
      from: 'mail/compose',
      to: 'Template list',
      status: 'No UI',
    },
    'Templates - Patch': {
      route: '/mail/compose',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → updateTemplate()',
      when: 'Edit existing template (planned)',
      flow: 'Template editor → **Patch**',
      from: 'compose templates UI',
      to: 'Updated template',
      status: 'No UI',
    },
    'Signature - Get': {
      route: '/mail/settings',
      file: 'app/mail/settings.tsx',
      service: 'services/mail.ts → getSignature()',
      when: 'Settings screen mount',
      flow: 'accounts → settings → **Signature Get** → show editor',
      from: 'mail/accounts',
      to: 'mail/settings',
      status: 'Not wired',
    },
    'Signature - Patch': {
      route: '/mail/settings',
      file: 'app/mail/settings.tsx',
      service: 'services/mail.ts → updateSignature()',
      when: 'User saves signature',
      flow: 'settings → edit HTML → **Signature Patch**',
      from: 'mail/settings',
      to: 'Same screen (saved toast)',
      status: 'Not wired',
    },
    'Drafts - AI Generate': {
      route: '/mail/compose',
      file: 'app/mail/compose.tsx',
      service: 'services/mail.ts → generateDraft()',
      when: 'User taps AI assist / generate draft',
      flow: 'compose → prompt → **AI Generate** → insert HTML into body',
      from: 'mail/compose',
      to: 'Compose editor',
      status: 'Service exists; button shows preview alert',
    },
  },
  '4. Internal Meetings': {
    'List - Upcoming': {
      route: '/(tabs)/meetings',
      file: 'app/(tabs)/meetings.tsx',
      service: 'services/meetings.ts → list({ status: "scheduled" }) (planned)',
      when: 'Meetings tab mount; Upcoming segment selected; pull-to-refresh',
      flow: 'Tab → Upcoming → **List - Upcoming** → render cards',
      from: 'Tab bar Meetings',
      to: 'meeting/[id]',
      status: 'Mock data',
    },
    'List - Completed': {
      route: '/(tabs)/meetings',
      file: 'app/(tabs)/meetings.tsx',
      service: 'services/meetings.ts → list({ status: "ended" }) (planned)',
      when: 'User switches to Completed segment',
      flow: 'Meetings tab → Completed → **List - Completed**',
      from: '(tabs)/meetings',
      to: 'meeting/[id]',
      status: 'Mock data',
    },
    'List - Cancelled': {
      route: '/(tabs)/meetings',
      file: 'app/(tabs)/meetings.tsx',
      service: 'services/meetings.ts → list({ status: "cancelled" }) (planned)',
      when: 'User switches to Cancelled segment',
      flow: 'Meetings tab → Cancelled → **List - Cancelled**',
      from: '(tabs)/meetings',
      to: 'meeting/[id]',
      status: 'Mock data',
    },
    Detail: {
      route: '/meeting/[id]',
      file: 'app/meeting/[id].tsx',
      service: 'services/meetings.ts → get(meetingId) (planned)',
      when: 'User taps a meeting row from any list',
      flow: 'List row tap → **Detail** → show join, participants, recordings',
      from: '(tabs)/meetings',
      to: 'LiveKit room (folder 5)',
      status: 'Mock data',
    },
    Create: {
      route: '/meeting/create',
      file: 'app/meeting/create.tsx',
      service: 'services/meetings.ts → create(payload) (planned)',
      when: 'User submits Schedule form (FAB or header +)',
      flow: 'meetings → create → fill form → **Create** → back to Upcoming list',
      from: '(tabs)/meetings',
      to: '(tabs)/meetings',
      status: 'Mock submit',
    },
    'Patch / Reschedule': {
      route: '/meeting/create',
      file: 'app/meeting/create.tsx',
      service: 'services/meetings.ts → update(meetingId, patch) (planned)',
      when: 'Edit existing meeting and save',
      flow: 'meeting/[id] → Edit → create (prefilled) → **Patch**',
      from: 'meeting/[id]',
      to: 'meeting/[id] or meetings tab',
      status: 'Not wired',
    },
    'Cancel (PATCH status)': {
      route: '/(tabs)/meetings | /meeting/[id]',
      file: 'app/(tabs)/meetings.tsx, app/meeting/[id].tsx',
      service: 'services/meetings.ts → update(id, { status: "cancelled" }) (planned)',
      when: 'User confirms Cancel on meeting card or detail',
      flow: 'Cancel action → **Cancel PATCH** → move to Cancelled segment',
      from: 'meetings list or detail',
      to: 'Cancelled list',
      status: 'Not wired',
    },
    Delete: {
      route: '(none)',
      file: '—',
      service: 'services/meetings.ts → remove(meetingId) (planned)',
      when: 'Permanent delete (admin action — no mobile UI yet)',
      flow: '—',
      from: '—',
      to: '—',
      status: 'No mobile UI',
    },
    'Resend Invites': {
      route: '/meeting/[id]',
      file: 'app/meeting/[id].tsx',
      service: 'services/meetings.ts → resendInvites(meetingId) (planned)',
      when: 'Resend button on detail (planned)',
      flow: 'Detail → Resend → **Resend Invites**',
      from: 'meeting/[id]',
      to: 'Same screen (toast)',
      status: 'No UI',
    },
    'Recordings for Meeting': {
      route: '/meeting/[id]',
      file: 'app/meeting/[id].tsx',
      service: 'services/meetings.ts → getRecordings(meetingId) (planned)',
      when: 'Detail screen loads recording section',
      flow: 'Detail → **Recordings for Meeting** → playback list',
      from: 'meeting/[id]',
      to: 'Folder 6 transcript/download',
      status: 'Mock player',
    },
  },
  '5. LiveKit': {
    'Token - Meeting': {
      route: '/meeting/[id]',
      file: 'app/meeting/[id].tsx',
      service: 'services/livekit.ts → getMeetingToken(roomName) (planned)',
      when: 'User taps **Join Meeting** on detail',
      flow: 'Detail → **Token - Meeting** → open LiveKit room component',
      from: 'meeting/[id]',
      to: 'In-call UI (planned)',
      status: 'Not wired',
    },
    'Token - Chat Call': {
      route: '/chat/[id] | /call/new',
      file: 'app/chat/[id].tsx, app/call/new.tsx',
      service: 'services/livekit.ts → getChatCallToken(conversationId) (planned)',
      when: 'Start audio/video from chat or new call screen',
      flow: 'chat → call button → **Start Call** (folder 8) → **Token - Chat Call** → room',
      from: 'chat/[id], call/new',
      to: 'In-call UI',
      status: 'Not wired',
    },
    'Recording - Start': {
      route: 'In-call room UI (planned)',
      file: 'components/livekit-room.tsx (planned)',
      service: 'services/livekit.ts → startRecording(roomName) (planned)',
      when: 'Host taps Record during meeting',
      flow: 'In room → **Recording Start** → show REC indicator',
      from: 'LiveKit room',
      to: 'Same room',
      status: 'No in-call UI',
    },
    'Recording - Stop': {
      route: 'In-call room UI (planned)',
      file: 'components/livekit-room.tsx (planned)',
      service: 'services/livekit.ts → stopRecording(egressId) (planned)',
      when: 'Host stops recording',
      flow: 'In room → Stop → **Recording Stop**',
      from: 'LiveKit room',
      to: 'meeting/[id] recordings refresh',
      status: 'No in-call UI',
    },
    'Recording - Status': {
      route: 'In-call room UI (planned)',
      file: 'components/livekit-room.tsx (planned)',
      service: 'services/livekit.ts → getRecordingStatus(roomName) (planned)',
      when: 'Poll while recording active',
      flow: 'Room mount / interval → **Recording Status**',
      from: 'LiveKit room',
      to: 'REC badge state',
      status: 'No in-call UI',
    },
  },
  '6. Recordings (Global)': {
    'List Recordings': {
      route: '/meeting/[id]',
      file: 'app/meeting/[id].tsx',
      service: 'services/recordings.ts → listAll() (planned)',
      when: 'Global library or meeting detail needs all recordings',
      flow: 'Detail recordings section → **List Recordings** (or per-meeting API in folder 4)',
      from: 'meeting/[id]',
      to: 'Playback / transcript',
      status: 'Mock',
    },
    'Recording Transcript': {
      route: '/meeting/[id] (planned transcript tab)',
      file: 'app/meeting/[id].tsx',
      service: 'services/recordings.ts → getTranscript(recordingId) (planned)',
      when: 'User opens transcript for a recording',
      flow: 'Recording row → **Transcript** → scrollable text',
      from: 'meeting/[id]',
      to: 'Transcript view',
      status: 'No UI',
    },
  },
  '7. File Storage': {
    List: {
      route: '/(tabs)/files | /files/category/[id]',
      file: 'app/(tabs)/files.tsx, app/files/category/[id].tsx',
      service: 'services/files.ts → list({ prefix }) (planned)',
      when: 'Files tab mount; category drill-in; pull-to-refresh',
      flow: 'Tab → categories → category/[id] → **List** with prefix',
      from: 'Tab bar Files',
      to: 'files/[id]',
      status: 'Mock listings',
    },
    'Download (signed URL)': {
      route: '/files/[id]',
      file: 'app/files/[id].tsx',
      service: 'services/files.ts → getDownloadUrl(key) (planned)',
      when: 'User taps Download or opens file preview',
      flow: 'File row → **Download** → open signed URL in browser/viewer',
      from: 'files/[id], category list',
      to: 'OS viewer',
      status: 'Not wired',
    },
    'Upload (multipart)': {
      route: '/files/upload',
      file: 'app/files/upload.tsx',
      service: 'services/files.ts → upload(file, folder?) (planned)',
      when: 'User picks file and taps Upload',
      flow: 'files tab → Upload FAB → upload screen → **Upload** → back to list',
      from: '(tabs)/files',
      to: 'files/category or files tab',
      status: 'Mock UI',
    },
    'Delete Object': {
      route: '/files/[id]',
      file: 'app/files/[id].tsx',
      service: 'services/files.ts → deleteObject(key) (planned)',
      when: 'User confirms delete on file detail',
      flow: 'Detail → Delete → **Delete Object** → router.back()',
      from: 'files/[id]',
      to: 'Previous list',
      status: 'Not wired',
    },
    'Create Folder': {
      route: '(none)',
      file: '—',
      service: 'services/files.ts → createFolder(name) (planned)',
      when: 'New folder action (no mobile UI yet)',
      flow: '—',
      from: '—',
      to: '—',
      status: 'No mobile UI',
    },
  },
  '8. Chats': {
    'List Conversations': {
      route: '/(tabs)/chats',
      file: 'app/(tabs)/chats.tsx',
      service: 'services/chat.ts → listConversations() (planned)',
      when: 'Chats tab mount; pull-to-refresh; return from chat/[id]',
      flow: 'Tab → **List Conversations** → render inbox rows',
      from: 'Tab bar Chats',
      to: 'chat/[id]',
      status: 'Mock data',
    },
    'Conversation Detail': {
      route: '/chat/[id]',
      file: 'app/chat/[id].tsx',
      service: 'services/chat.ts → getConversation(id) (planned)',
      when: 'Chat header mount (parallel with Messages)',
      flow: 'Open chat → **Conversation Detail** → title, participants',
      from: '(tabs)/chats',
      to: 'chat/[id]',
      status: 'Mock',
    },
    Messages: {
      route: '/chat/[id]',
      file: 'app/chat/[id].tsx',
      service: 'services/chat.ts → getMessages(conversationId) (planned)',
      when: 'Chat screen mount; scroll-up pagination',
      flow: 'chat/[id] → **Messages** → render timeline',
      from: '(tabs)/chats',
      to: 'Same chat',
      status: 'Mock',
    },
    'Send Message': {
      route: '/chat/[id]',
      file: 'app/chat/[id].tsx',
      service: 'services/chat.ts → sendMessage(conversationId, content) (planned)',
      when: 'User sends text from composer',
      flow: 'Composer Send → **Send Message** → append to list (+ socket)',
      from: 'chat/[id]',
      to: 'Same chat',
      status: 'Mock local only',
    },
    'Send Message with File': {
      route: '/chat/[id]',
      file: 'app/chat/[id].tsx',
      service: 'services/chat.ts → uploadAndSend(conversationId, files) (planned)',
      when: 'User attaches image/file and sends',
      flow: 'Attach → Send → **Send with File**',
      from: 'chat/[id]',
      to: 'Same chat',
      status: 'Not wired',
    },
    'Mark Read': {
      route: '/chat/[id] | /(tabs)/chats',
      file: 'app/chat/[id].tsx, app/(tabs)/chats.tsx',
      service: 'services/chat.ts → markRead(conversationId) (planned)',
      when: 'Chat opens or user views thread',
      flow: 'Open chat → **Mark Read** → clear badge on tab list',
      from: 'chat/[id]',
      to: '(tabs)/chats (badge update)',
      status: 'Not wired',
    },
    'Start Call': {
      route: '/chat/[id]',
      file: 'app/chat/[id].tsx',
      service: 'services/chat.ts → initiateCall(conversationId, callType) (planned)',
      when: 'User taps phone/video icon in chat header',
      flow: 'chat → **Start Call** → **Token - Chat Call** (folder 5) → room',
      from: 'chat/[id]',
      to: 'LiveKit in-call UI',
      status: 'Not wired',
    },
    'Socket Token': {
      route: '(app bootstrap)',
      file: 'app/_layout.tsx, services/chat-socket.ts (planned)',
      service: 'services/chat.ts → getSocketToken() (planned)',
      when: 'After login, before subscribing to realtime events',
      flow: 'Login → **Socket Token** → connect Socket.IO → listen for messages/calls',
      from: 'App bootstrap',
      to: 'All chat screens',
      status: 'Not implemented',
    },
    'User Search': {
      route: '/chat/new | /call/new',
      file: 'app/chat/new.tsx, app/call/new.tsx',
      service: 'services/chat.ts → searchUsers(q) (planned)',
      when: 'User types in search field on new chat/call screens',
      flow: 'new chat → type name → **User Search** → tap user → open/create conversation',
      from: 'chat/new, call/new',
      to: 'chat/[id]',
      status: 'Mock users',
    },
    'In-App Calls List': {
      route: '/(tabs)/calls',
      file: 'app/(tabs)/calls.tsx',
      service: 'services/chat.ts → listInAppCalls() (planned)',
      when: 'Calls tab — filter to in-app subset (optional alongside folder 9)',
      flow: 'Calls tab → in-app filter → **In-App Calls List**',
      from: '(tabs)/calls',
      to: 'chat/[id] or call detail',
      status: 'Mock; prefer **All Calls** from folder 9',
    },
  },
  '9. Unified Calls': {
    'All Calls': {
      route: '/(tabs)/calls',
      file: 'app/(tabs)/calls.tsx',
      service: 'services/communication.ts → listUnifiedCalls(filters) (planned)',
      when: 'Calls tab mount; filter change (missed/incoming/outgoing); refresh',
      flow: 'Tab → **All Calls** → unified telephony + in-app log',
      from: 'Tab bar Calls',
      to: 'chat/[id], meeting/[id], or external dialer metadata',
      status: 'Mock data',
    },
  },
};

/** Outlook reuses Gmail screens; map request names and tweak provider. */
const OUTLOOK_GMAIL_NAME_MAP = {
  'OAuth - Start Microsoft': 'OAuth - Start Google',
  'OAuth - Microsoft Callback': 'OAuth - Google Callback',
};

export function resolveAppConnection(folderName, requestName) {
  const direct = APP_CONNECTION_BY_FOLDER[folderName]?.[requestName];
  if (direct) return direct;

  if (folderName === '3. Mail - Outlook') {
    const gmailName = OUTLOOK_GMAIL_NAME_MAP[requestName] || requestName;
    const base = APP_CONNECTION_BY_FOLDER['2. Mail - Gmail']?.[gmailName];
    if (!base) return null;
    return {
      ...base,
      service: String(base.service).replace(/gmail/gi, 'outlook').replace(/Google/g, 'Microsoft'),
      when: String(base.when).replace(/Gmail/g, 'Outlook').replace(/Google/g, 'Microsoft'),
      flow: String(base.flow).replace(/Gmail/g, 'Outlook').replace(/Google/g, 'Microsoft'),
    };
  }

  return null;
}

export function formatAppConnectionSection(conn) {
  if (!conn) return null;
  const lines = [
    '### How to connect in the app',
    `- **Screen route:** \`${conn.route}\``,
    `- **File:** \`${conn.file}\``,
    `- **Service:** ${conn.service}`,
    `- **When to call:** ${conn.when}`,
    `- **Navigation flow:** ${conn.flow}`,
    `- **From → To:** ${conn.from} → ${conn.to}`,
    `- **Wiring status:** ${conn.status}`,
  ];
  return lines.join('\n');
}
