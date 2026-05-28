import fs from 'fs';
import path from 'path';
import { BACKEND_BY_FOLDER } from './mobile-api-backend-map.mjs';
import {
  APP_NAV_OVERVIEW,
  FOLDER_SCREEN_TREE,
  resolveAppConnection,
  formatAppConnectionSection,
} from './mobile-api-app-connection.mjs';

const collectionPath = path.resolve(
  'postman/Dharwin-Mobile-App-APIs.postman_collection.json'
);

/** folderName -> requestName -> mobile screen / feature */
const USAGE_BY_FOLDER = {
  '1. Auth': {
    Login: 'login.tsx — Sign in (not wired yet; mock navigation today)',
    'Me (current user)': 'Session bootstrap after login (planned; no caller yet)',
    'Refresh Tokens': 'services/api.ts — silent token refresh (planned)',
    Logout: 'mail/accounts.tsx — Sign out of all accounts (planned)',
  },
  '2. Mail - Gmail': {
    'GET Accounts': 'mail/accounts.tsx, mail/add-account.tsx, (tabs)/mails.tsx account switcher',
    'OAuth - Start Google': 'mail/add-account.tsx — Connect Gmail',
    'OAuth - Google Callback': 'Deep link dharwin:// after Google OAuth (handler not implemented)',
    'DELETE Account': 'mail/add-account.tsx — Revoke Gmail account',
    'List Threads': '(tabs)/mails.tsx, mail/[folder].tsx — Inbox & folder lists',
    'Thread Detail': 'mail/thread/[id].tsx — Read thread',
    'Single Message': 'mail/thread/[id].tsx — Single message body',
    'Send Message': 'mail/compose.tsx — New email',
    Reply: 'mail/compose.tsx?mode=reply',
    'Reply All': 'mail/compose.tsx — Reply all',
    Forward: 'mail/compose.tsx?mode=forward',
    'Patch Message (labels/read)': 'mail/thread/[id].tsx — Star, archive, mark read',
    'Batch Modify Messages': 'Bulk mail actions (no mobile UI yet)',
    'Trash Thread': 'mail/thread/[id].tsx — Delete / trash thread',
    'Get Attachment': 'mail/thread/[id].tsx — Download attachment',
    Labels: 'MailSidebar + mail/[folder].tsx — Folder/label list',
    'Templates - List': 'Compose templates picker (no screen yet)',
    'Templates - Create': 'Compose templates (no screen yet)',
    'Templates - Patch': 'Compose templates (no screen yet)',
    'Signature - Get': 'mail/settings.tsx — Load signature',
    'Signature - Patch': 'mail/settings.tsx — Save signature',
    'Drafts - AI Generate': 'mail/compose.tsx — AI draft assist (services/mail.ts)',
  },
  '3. Mail - Outlook': {
    'GET Accounts': 'mail/accounts.tsx, mail/add-account.tsx — Outlook provider',
    'OAuth - Start Microsoft': 'mail/add-account.tsx — Connect Outlook',
    'OAuth - Microsoft Callback': 'Deep link after Microsoft OAuth (handler not implemented)',
    'DELETE Account': 'mail/add-account.tsx — Revoke Outlook account',
    'List Threads': '(tabs)/mails.tsx, mail/[folder].tsx — Outlook threads',
    'Thread Detail': 'mail/thread/[id].tsx — Read thread',
    'Single Message': 'mail/thread/[id].tsx — Single message body',
    'Send Message': 'mail/compose.tsx — New email',
    Reply: 'mail/compose.tsx?mode=reply',
    'Reply All': 'mail/compose.tsx — Reply all',
    Forward: 'mail/compose.tsx?mode=forward',
    Labels: 'MailSidebar + mail/[folder].tsx — Outlook folders',
  },
  '4. Internal Meetings': {
    'List - Upcoming': '(tabs)/meetings.tsx — Upcoming tab (status=scheduled)',
    'List - Completed': '(tabs)/meetings.tsx — Completed tab (status=ended)',
    'List - Cancelled': '(tabs)/meetings.tsx — Cancelled meetings list',
    Detail: 'meeting/[id].tsx — Meeting detail, join, recording',
    Create: 'meeting/create.tsx — Schedule new meeting',
    'Patch / Reschedule': 'meeting/create.tsx — Edit / reschedule existing meeting',
    'Cancel (PATCH status)': '(tabs)/meetings.tsx — Cancel meeting from list',
    Delete: 'Permanent delete (no mobile UI yet)',
    'Resend Invites': 'Resend participant invites (no mobile UI yet)',
    'Recordings for Meeting': 'meeting/[id].tsx — Recording section / play',
  },
  '5. LiveKit': {
    'Token - Meeting': 'meeting/[id].tsx — Join Meeting (LiveKit room)',
    'Token - Chat Call': 'chat/[id].tsx call button, call/new.tsx — In-app audio/video call',
    'Recording - Start': 'In-meeting room controls (not built yet)',
    'Recording - Stop': 'In-meeting room controls (not built yet)',
    'Recording - Status': 'In-meeting recording indicator (not built yet)',
  },
  '6. Recordings (Global)': {
    'List Recordings': 'meeting/[id].tsx — Play recording; global list (no tab yet)',
    'Recording Transcript': 'Meeting transcript view (no screen yet)',
  },
  '7. File Storage': {
    List: '(tabs)/files.tsx, files/category/[id].tsx — Browse files',
    'Download (signed URL)': 'files/[id].tsx — Download file',
    'Upload (multipart)': 'files/upload.tsx — Upload file',
    'Delete Object': 'files/[id].tsx — Delete file',
    'Create Folder': 'Create folder (no mobile UI yet)',
  },
  '8. Chats': {
    'List Conversations': '(tabs)/chats.tsx — Chat inbox',
    'Conversation Detail': 'chat/[id].tsx — Chat header / metadata',
    Messages: 'chat/[id].tsx — Message timeline',
    'Send Message': 'chat/[id].tsx — Composer send text',
    'Send Message with File': 'chat/[id].tsx — Attach file in composer',
    'Mark Read': 'chat/[id].tsx / (tabs)/chats.tsx — Clear unread badge',
    'Start Call': 'chat/[id].tsx — Start call from chat',
    'Socket Token': 'Realtime chat (SignalR/socket layer — not implemented)',
    'User Search': 'chat/new.tsx, call/new.tsx — Find users to chat/call',
    'In-App Calls List': '(tabs)/calls.tsx — In-app call history subset',
  },
  '9. Unified Calls': {
    'All Calls': '(tabs)/calls.tsx — Unified call log (telephony + in-app)',
  },
};

/** Rich folder header: overview + in-app workflow */
const FOLDER_GUIDE = {
  '1. Auth': {
    overview:
      'JWT authentication for the mobile app. All other folders require a valid `accessToken` (Bearer) except Login and Refresh Tokens.',
    tab: 'Sign in (pre-tabs)',
    routes: '`app/login.tsx`, `services/api.ts`, `services/auth.ts` (planned)',
    workflow: [
      'User enters email/password on **login.tsx** → call **Login** → store `accessToken` + `refreshToken` in secure storage.',
      'On app launch, call **Me** to hydrate user profile and permissions.',
      'When API returns 401, call **Refresh Tokens** then retry the failed request.',
      'On sign-out from **mail/accounts.tsx**, call **Logout** and clear local tokens.',
    ],
    postman: [
      'Set collection variables `email` and `password`.',
      'Run **Login** — test script saves tokens to `accessToken` / `refreshToken`.',
      'All other requests inherit Bearer auth from collection level.',
    ],
  },
  '2. Mail - Gmail': {
    overview:
      'Gmail integration via connected accounts. Provider prefix: `/email/*`. Mail API client lives in `services/mail.ts`.',
    tab: 'Mails',
    routes: '`app/(tabs)/mails.tsx`, `app/mail/*` (thread, compose, accounts, settings)',
    workflow: [
      '**GET Accounts** on Mails tab load → populate account switcher.',
      '**OAuth - Start Google** opens browser; callback completes account link.',
      '**List Threads** + **Labels** power inbox and sidebar folders.',
      'Open thread → **Thread Detail** / **Single Message**; reply → **Reply** / **Send Message** via compose.',
      '**Patch Message**, **Trash Thread**, **Get Attachment** from thread actions.',
    ],
    postman: [
      'Run **GET Accounts** after login — saves `accountId` to collection variables.',
      'Use `accountId` in thread/list/send requests.',
      'OAuth requests are browser-based; use mobile deep link in production.',
    ],
  },
  '3. Mail - Outlook': {
    overview:
      'Microsoft Outlook / Office 365 mail. Provider prefix: `/outlook/*`. Same UI as Gmail; pass `provider=outlook` in `services/mail.ts`.',
    tab: 'Mails',
    routes: 'Same as Gmail — `app/mail/*` with Outlook account selected',
    workflow: [
      '**GET Accounts** lists Outlook-linked accounts.',
      '**OAuth - Start Microsoft** → user signs in → **OAuth - Microsoft Callback**.',
      'Thread read/send/reply flow mirrors Gmail folder (2) with `outlookAccountId`.',
    ],
    postman: [
      'Run **GET Accounts** — saves `outlookAccountId` when an Outlook account exists.',
      'If testing Gmail only, skip this folder.',
    ],
  },
  '4. Internal Meetings': {
    overview:
      'Schedule and manage Dharwin-native meetings (not external calendar sync). Base path: `/meetings`.',
    tab: 'Meetings',
    routes: '`app/(tabs)/meetings.tsx`, `app/meeting/[id].tsx`, `app/meeting/create.tsx`',
    workflow: [
      'Meetings tab loads three lists: **List - Upcoming**, **List - Completed**, **List - Cancelled**.',
      'Tap meeting → **Detail** on `meeting/[id].tsx`.',
      'Schedule → **Create** from `meeting/create.tsx`; edit → **Patch / Reschedule**.',
      'Cancel from list → **Cancel (PATCH status)**; recordings section → **Recordings for Meeting**.',
    ],
    postman: [
      'Run **List - Upcoming** to copy a `meetingId` into variables.',
      'Use **Detail** before **Patch** or **Cancel** to inspect current state.',
    ],
  },
  '5. LiveKit': {
    overview:
      'Real-time A/V rooms powered by LiveKit. Tokens are short-lived; fetch immediately before joining.',
    tab: 'Meetings + Chats (calls)',
    routes: '`app/meeting/[id].tsx` (join meeting), `app/chat/[id].tsx`, `app/call/new.tsx`',
    workflow: [
      'Join scheduled meeting → **Token - Meeting** with `meetingId` → open LiveKit room UI.',
      'Start chat call → **Token - Chat Call** with conversation/participant context.',
      'Optional: **Recording - Start/Stop/Status** during active room (UI not built yet).',
    ],
    postman: [
      'Requires valid `meetingId` or chat context from folders 4 / 8.',
      'Token response is used client-side only — do not log in production.',
    ],
  },
  '6. Recordings (Global)': {
    overview:
      'Global recording library and transcripts. Complements per-meeting recordings in folder 4.',
    tab: 'Meetings (playback)',
    routes: '`app/meeting/[id].tsx` recording player; no dedicated Recordings tab yet',
    workflow: [
      'After meeting ends, **List Recordings** fetches available files.',
      'Tap recording → stream URL from list response.',
      '**Recording Transcript** for AI/search transcript view (planned).',
    ],
    postman: [
      'Use `recordingId` from **List Recordings** for transcript request.',
    ],
  },
  '7. File Storage': {
    overview:
      'Org file storage (S3-backed). Upload, browse, download, delete objects and folders.',
    tab: 'Files',
    routes: '`app/(tabs)/files.tsx`, `app/files/[id].tsx`, `app/files/upload.tsx`, `app/files/category/[id].tsx`',
    workflow: [
      'Files tab → **List** by category or root.',
      'Upload FAB → **Upload (multipart)** from `files/upload.tsx`.',
      'Tap file → **Download (signed URL)**; swipe/delete → **Delete Object**.',
    ],
    postman: [
      'Upload uses form-data — pick a local file in Postman.',
      'Download returns a signed URL; open in browser to verify.',
    ],
  },
  '8. Chats': {
    overview:
      'In-app messaging between Dharwin users. REST for history; realtime via socket token (planned).',
    tab: 'Chats (+ Calls history subset)',
    routes: '`app/(tabs)/chats.tsx`, `app/chat/[id].tsx`, `app/chat/new.tsx`',
    workflow: [
      'Chats tab → **List Conversations**.',
      'Open chat → **Messages** paginated; send → **Send Message** or **Send Message with File**.',
      'New chat → **User Search** on `chat/new.tsx`.',
      'Unread badge → **Mark Read**; call button → **Start Call** (pairs with folder 5).',
    ],
    postman: [
      'Run **List Conversations** → set `conversationId`.',
      '**Send Message** posts to `/chats/conversations/{{conversationId}}/messages`.',
    ],
  },
  '9. Unified Calls': {
    overview:
      'Single call log merging telephony and in-app LiveKit calls. Distinct from **In-App Calls List** in folder 8.',
    tab: 'Calls',
    routes: '`app/(tabs)/calls.tsx`',
    workflow: [
      'Calls tab on load → **All Calls** with filters (missed, incoming, outgoing).',
      'Tap row → navigate to related chat or meeting when metadata present.',
    ],
    postman: [
      'Compare with **8. Chats → In-App Calls List** — unified vs chat-scoped history.',
    ],
  },
};

function getUrlPath(item) {
  const url = item.request?.url;
  if (!url) return '';
  if (typeof url === 'string') {
    const m = url.match(/\{\{baseUrl\}\}(\/[^\s?]*)/);
    return m ? m[1] : url.replace(/\{\{baseUrl\}\}/, '');
  }
  if (url.path) return `/${url.path.join('/')}`;
  return url.raw || '';
}

function requestFooter(folderName) {
  if (folderName.startsWith('8. Chats') || folderName.startsWith('9. Unified')) {
    return '_App repo: `Dharwin App/my-app`. Chat/call screens use mock data until REST + LiveKit are wired._';
  }
  if (folderName.startsWith('4.') || folderName.startsWith('5.') || folderName.startsWith('6.')) {
    return '_App repo: `Dharwin App/my-app`. Meeting/LiveKit flows partially mocked on device._';
  }
  if (folderName.startsWith('7.')) {
    return '_App repo: `Dharwin App/my-app`. Files tab uses mock listings until storage API is wired._';
  }
  if (folderName.startsWith('1.')) {
    return '_App repo: `Dharwin App/my-app`. Auth service scaffold in `services/api.ts`; login screen not yet calling backend._';
  }
  return '_App repo: `Dharwin App/my-app`. Mail client in `services/mail.ts`; most mail screens still use mock data until wired._';
}

function escapeCell(text) {
  return String(text || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatRequestDescription(name, folderName, item) {
  const mobile = USAGE_BY_FOLDER[folderName]?.[name];
  const backend = BACKEND_BY_FOLDER[folderName]?.[name];
  const appConn = resolveAppConnection(folderName, name);
  const method = item.request?.method || '';
  const apiPath = getUrlPath(item);

  const lines = [];
  lines.push(`**API:** \`${method} ${apiPath}\``);
  lines.push('');
  lines.push('### Mobile app');
  lines.push(
    mobile
      ? mobile
      : 'See `Dharwin App/my-app/app/` (Expo Router).'
  );
  const appSection = formatAppConnectionSection(appConn);
  if (appSection) {
    lines.push('');
    lines.push(appSection);
  }
  lines.push('');
  lines.push('### Backend (uat.dharwin.backend)');
  if (backend) {
    lines.push(`- **Route file:** \`${backend.route}\``);
    lines.push(`- **Handler:** \`${backend.handler}\``);
    lines.push(`- **What it does:** ${backend.does}`);
    lines.push(`- **How to call:** ${backend.howToUse}`);
    lines.push(`- **Auth / permissions:** ${backend.auth}`);
  } else {
    lines.push('- See matching route under `src/routes/v1/` (mounted at `/v1` prefix).');
  }
  lines.push('');
  lines.push(requestFooter(folderName));
  return lines.join('\n');
}

function formatFolderDescription(folderName, requests) {
  const guide = FOLDER_GUIDE[folderName];
  if (!guide) return '';

  const lines = [];
  lines.push(`## ${folderName}`);
  lines.push('');
  lines.push(guide.overview);
  lines.push('');
  lines.push(`**Mobile tab:** ${guide.tab}`);
  lines.push(`**App routes:** ${guide.routes}`);
  lines.push('');
  const screenTree = FOLDER_SCREEN_TREE[folderName];
  if (screenTree) {
    lines.push('### App screens & inner routes');
    lines.push('');
    lines.push(screenTree);
    lines.push('');
  }
  lines.push('### How to use in the mobile app');
  for (const step of guide.workflow) {
    lines.push(`- ${step}`);
  }
  lines.push('');
  lines.push('### Postman testing');
  for (const step of guide.postman) {
    lines.push(`- ${step}`);
  }
  lines.push('');
  lines.push('### APIs in this folder');
  lines.push('');
  lines.push('| Request | API | App screen | When to call | Backend handler | What it does |');
  lines.push('|---------|-----|------------|--------------|-----------------|--------------|');

  for (const req of requests) {
    const method = req.request?.method || '';
    const apiPath = getUrlPath(req);
    const mobile = USAGE_BY_FOLDER[folderName]?.[req.name] || '—';
    const appConn = resolveAppConnection(folderName, req.name);
    const screen = appConn ? escapeCell(`${appConn.route} (${appConn.file})`) : escapeCell(mobile);
    const when = appConn ? escapeCell(appConn.when) : '—';
    const backend = BACKEND_BY_FOLDER[folderName]?.[req.name];
    const handler = backend ? `\`${backend.handler}\`` : '—';
    const does = backend ? escapeCell(backend.does) : '—';
    lines.push(
      `| ${req.name} | \`${method} ${apiPath}\` | ${screen} | ${when} | ${handler} | ${does} |`
    );
  }

  lines.push('');
  lines.push('### Backend route files');
  const routeFiles = [
    ...new Set(
      requests
        .map((req) => BACKEND_BY_FOLDER[folderName]?.[req.name]?.route)
        .filter(Boolean)
    ),
  ];
  if (routeFiles.length) {
    for (const rf of routeFiles) {
      lines.push(`- \`${rf}\``);
    }
  } else {
    lines.push('- See `src/routes/v1/index.js` for mount paths.');
  }

  return lines.join('\n');
}

function walkItems(items, folderName = '') {
  for (const entry of items) {
    if (entry.item) {
      const fn = entry.name;
      const requests = entry.item.filter((child) => child.request);
      if (FOLDER_GUIDE[fn] && requests.length) {
        entry.description = formatFolderDescription(fn, requests);
      }
      walkItems(entry.item, fn);
    } else if (entry.request) {
      entry.request.description = formatRequestDescription(
        entry.name,
        folderName,
        entry
      );
    }
  }
}

const raw = fs.readFileSync(collectionPath, 'utf8');
const collection = JSON.parse(raw);

collection.info.description = [
  'Full backend coverage for the **Dharwin mobile app** (Expo: `Dharwin App/my-app`).',
  '',
  '**Setup:** Set `email` / `password` in collection variables → run **1. Auth → Login** → run any request.',
  '',
  'Each **folder** includes: app screen tree (login + 5 tabs + inner routes), mobile workflow, Postman tips, and a table mapping every API to app screen, when to call, backend handler, and purpose.',
  'Each **request** documents: mobile screen, **How to connect in the app** (route, file, service, flow, wiring status), backend route/handler, and auth.',
  '',
  APP_NAV_OVERVIEW,
  '',
  'All routes mount under `/v1` (included in `baseUrl`). Source: `uat.dharwin.backend/src/routes/v1/`.',
  '',
  '| Mobile tab | Postman folder | Backend prefix |',
  '|------------|----------------|----------------|',
  '| Sign in | 1. Auth | `/auth` |',
  '| Mails | 2–3. Mail | `/email`, `/outlook` |',
  '| Meetings | 4. Internal Meetings | `/internal-meetings` |',
  '| LiveKit | 5. LiveKit | `/livekit` |',
  '| Recordings | 6. Recordings | `/recordings` |',
  '| Files | 7. File Storage | `/file-storage` |',
  '| Chats | 8. Chats | `/chats` |',
  '| Calls | 9. Unified Calls | `/communication` |',
].join('\n');

walkItems(collection.item);

fs.writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`);
console.log('Annotated', collectionPath);
