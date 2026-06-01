/**
 * Build app-scoped Postman collection from full Dharwin-Mobile-App-APIs collection.
 * Keeps only endpoints the mobile app screens + services/mail.ts need.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'Dharwin-Mobile-App-APIs.postman_collection.json');
const OUT = path.join(__dirname, 'Dharwin-Mobile-App-APIs.app-only.postman_collection.json');

/** Request names to keep, by top-level folder name */
const KEEP_BY_FOLDER = {
  '1. Auth': new Set([
    'Login',
    'Me (current user)',
    'Refresh Tokens',
    'Logout',
    'Forgot Password',
    'Reset Password',
    'Change Password',
    'Verify Email',
    'My Permissions',
    'Page Capabilities',
  ]),
  '2. Mail - Gmail': new Set([
    'GET Accounts',
    'OAuth - Start Google',
    'DELETE Account',
    'List Threads',
    'Thread Detail',
    'Single Message',
    'Send Message',
    'Reply',
    'Reply All',
    'Forward',
    'Patch Message (labels/read)',
    'Batch Modify Messages',
    'Trash Thread',
    'Get Attachment',
    'Labels',
    'Templates - List',
    'Templates - Create',
    'Signature - Get',
    'Signature - Patch',
    'Drafts - AI Generate',
    'Connection Policy',
    'List Messages',
    'Create Label',
    'Delete Message',
  ]),
  '3. Mail - Outlook': new Set([
    'GET Accounts',
    'OAuth - Start Microsoft',
    'DELETE Account',
    'List Threads',
    'Thread Detail',
    'Single Message',
    'Send Message',
    'Reply',
    'Reply All',
    'Forward',
    'Labels',
    'Batch Modify Messages',
    'Trash Thread',
    'Patch Message (labels/read)',
    'Delete Message',
    'Get Attachment',
    'Create Label',
    'List Messages',
  ]),
  '4. Internal Meetings': new Set([
    'List - Upcoming',
    'List - Completed',
    'List - Cancelled',
    'Detail',
    'Create',
    'Patch / Reschedule',
    'Cancel (PATCH status)',
    'Resend Invites',
    'Recordings for Meeting',
  ]),
  '5. LiveKit': new Set([
    'Token - Meeting',
    'Token - Chat Call',
    'Recording - Start',
    'Recording - Stop',
    'Recording - Status',
    'Waiting Participants',
    'Admit Participant',
    'Remove Participant',
  ]),
  '6. Recordings (Global)': new Set(), // app uses per-meeting recordings only
  '7. File Storage': new Set(['List', 'Download (signed URL)', 'Upload (multipart)', 'Create Folder', 'Delete Object']),
  '8. Chats': new Set([
    'List Conversations',
    'Create Direct Conversation',
    'Create Group Conversation',
    'Conversation Detail',
    'Messages',
    'Send Message',
    'Send Message with File',
    'Mark Read',
    'User Search',
    'Socket Token',
    'Start Call',
    'Conversation Calls List',
    'Active Call for Conversation',
    'End Call by Room',
    'In-App Calls List',
  ]),
  '9. Unified Calls': new Set(['In-App Calls Only']),
};

function filterFolder(folder) {
  const keep = KEEP_BY_FOLDER[folder.name];
  if (!keep) return null;
  if (keep.size === 0) return null;

  const items = (folder.item || []).filter((req) => req.name && keep.has(req.name));
  if (items.length === 0) return null;
  return { ...folder, item: items };
}

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const filteredItems = (src.item || [])
  .map(filterFolder)
  .filter(Boolean);

const totalRequests = filteredItems.reduce((n, f) => n + (f.item?.length || 0), 0);

const out = {
  ...src,
  info: {
    ...src.info,
    _postman_id: 'dharwin-mobile-app-apis-app-only',
    name: 'Dharwin Mobile App APIs (App scope)',
    description:
      '**App-scoped** subset of backend APIs for the Dharwin Expo app (`Dharwin App/my-app`).\n\n' +
      'Includes only what mobile screens and `services/mail.ts` need. **Full backend coverage** remains in `Dharwin-Mobile-App-APIs.postman_collection.json`.\n\n' +
      '**Setup:** Set `email` / `password` → run **1. Auth → Login** → other requests.\n\n' +
      '**Wiring:** Most UI still uses mocks (`mail-mock`, `meetings-mock`, etc.). `services/mail.ts` defines the mail contract; auth/chats/meetings/files services are planned.\n\n' +
      `**This collection:** ${filteredItems.length} folders, ${totalRequests} requests (vs full catalog).\n\n` +
      'See `postman/APP_API_SCOPE.md` for include/exclude rationale.',
  },
  item: filteredItems,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Folders: ${filteredItems.length}, Requests: ${totalRequests}`);
