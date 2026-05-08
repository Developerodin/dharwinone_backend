/**
 * Central resolver mapping a notification's `type` + `relatedEntity` + `metadata`
 * to a frontend route. Callers should set `link` directly when the destination is known;
 * this resolver is the fallback used when `link` is missing or as a guard against
 * inconsistent emitters. Frontend mirrors this contract in
 * `shared/lib/notificationRoutes.ts` so both sides agree.
 */

const stripId = (v) => (v == null ? '' : String(v));

const ROUTE_MAP = {
  meeting: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.meetingId);
    return id ? `/meeting/${id}` : '/meeting';
  },
  meeting_reminder: ({ relatedEntity, metadata }) => {
    const id = stripId(relatedEntity?.id) || stripId(metadata?.meetingId);
    return id ? `/meeting/${id}` : '/meeting';
  },
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
  if (notif.link && typeof notif.link === 'string' && notif.link.startsWith('/')) return notif.link;
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
