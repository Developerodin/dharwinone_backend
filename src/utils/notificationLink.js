/**
 * Central resolver mapping a notification's `type` + `relatedEntity` + `metadata`
 * to a frontend route. Callers should set `link` directly when the destination is known;
 * this resolver is the fallback used when `link` is missing or as a guard against
 * inconsistent emitters. Frontend mirrors this contract in
 * `shared/lib/notificationRoutes.ts` so both sides agree.
 */

const stripId = (v) => (v == null ? '' : String(v));

/**
 * Convert stored notification links to in-app paths. Absolute URLs (legacy) become pathname+search.
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
export const normalizeNotificationLink = (link) => {
  if (!link || typeof link !== 'string') return null;
  const trimmed = link.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const u = new URL(trimmed);
    const path = u.pathname || '/';
    return `${path}${u.search || ''}`;
  } catch (_) {
    return null;
  }
};

const meetingRoute = ({ relatedEntity, metadata }) => {
  if (metadata?.navTarget === 'interviews_list') return '/ats/interviews';
  if (metadata?.navTarget === 'meetings_list') return '/communication/meetings';
  const id = stripId(relatedEntity?.id) || stripId(metadata?.meetingId);
  if (id) return `/join/room?room=${encodeURIComponent(id)}`;
  return metadata?.meetingKind === 'internal' ? '/communication/meetings' : '/ats/interviews';
};

const ROUTE_MAP = {
  meeting: meetingRoute,
  meeting_reminder: meetingRoute,
  chat_message: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.conversationId);
    return id ? `/communication/chats?conv=${id}` : '/communication/chats';
  },
  task: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.taskId);
    return id ? `/task/my-tasks?task=${id}` : '/task/my-tasks';
  },
  job_application: ({ metadata }) => {
    const jobId = stripId(metadata?.jobId);
    return jobId ? `/ats/jobs/${jobId}` : '/ats/my-applications';
  },
  offer: ({ metadata }) => {
    if (metadata?.section === 'pre-boarding') return '/ats/pre-boarding';
    return '/ats/offers-placement';
  },
  placement_update: () => '/ats/offers-placement',
  joining_reminder: () => '/ats/onboarding',
  onboarding_reminder: () => '/ats/onboarding',
  leave: () => '/settings/attendance/leave-requests',
  certificate: ({ metadata }) => {
    const id = stripId(metadata?.certificateId);
    return id ? `/training/certificates?id=${id}` : '/training/certificates';
  },
  course: ({ metadata }) => {
    const id = stripId(metadata?.courseId);
    return id ? `/training/courses/${id}` : '/training/courses';
  },
  project: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.projectId);
    return id ? `/apps/projects/project-list?id=${id}` : '/apps/projects/project-list';
  },
  account: () => '/ats/my-profile',
  recruiter: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.candidateId);
    return id ? `/ats/candidates/${id}` : '/ats/candidates';
  },
  assignment: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.candidateId);
    return id ? `/ats/candidates/${id}` : '/settings/agents/';
  },
  sop: () => '/ats/onboarding',
  support_ticket: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.ticketId);
    return id ? `/support-tickets/${id}` : '/support-tickets';
  },
  system: () => '/notifications',
  general: () => '/notifications',
};

/**
 * Resolve a frontend route for a notification.
 * @param {{ type?: string, link?: string|null, relatedEntity?: { type?: string, id?: any }, metadata?: any }} notif
 * @returns {string} a path beginning with `/`
 */
export const resolveNotificationLink = (notif = {}) => {
  const normalized = normalizeNotificationLink(notif.link);
  if (normalized) return normalized;
  const fn = ROUTE_MAP[notif.type];
  if (fn) {
    try {
      const route = fn(notif);
      if (route && route.startsWith('/')) return route;
    } catch (_) { /* fall through */ }
  }
  return '/notifications';
};

export default resolveNotificationLink;
