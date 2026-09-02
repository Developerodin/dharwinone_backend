import callRecordService from './callRecord.service.js';
import * as chatService from './chat.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

const MISSED_STATUS_VALUES = ['missed', 'no_answer', 'canceled', 'cancelled'];

function normalizeCallStatus(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/-/g, '_');
}

function callerIdFromChatCall(call) {
  const caller = call?.caller;
  if (!caller) return '';
  if (typeof caller === 'object') {
    return String(caller._id ?? caller.id ?? '');
  }
  return String(caller);
}

function isIncomingMissedChatCall(call, viewerUserId) {
  const status = normalizeCallStatus(call?.status);
  if (!MISSED_STATUS_VALUES.includes(status)) return false;
  if (!viewerUserId) return true;
  const callerId = callerIdFromChatCall(call);
  return Boolean(callerId && callerId !== String(viewerUserId));
}

function isIncomingMissedTelephonyRecord(record) {
  const status = normalizeCallStatus(record?.status);
  if (!MISSED_STATUS_VALUES.includes(status)) return false;
  const direction = normalizeCallStatus(
    record?.telephonyData?.direction ?? record?.direction ?? record?.telephonyData?.call_type,
  );
  if (!direction) return true;
  return direction === 'inbound' || direction === 'incoming';
}

/**
 * List unified calls (Bolna telephony + Chat in-app) with server-side merge, filter, sort, pagination.
 * @param {Object} options - { user, source, search, status, purpose, page, limit, sortBy, order }
 * @returns {Promise<{ results: Array, page, limit, total, totalPages }>}
 */
async function listUnifiedCalls(options = {}) {
  const user = options.user;
  const userId = user?.id || user?._id?.toString();
  const source = options.source || 'all';
  const page = Number(options.page) || 1;
  const limit = Math.min(Number(options.limit) || 25, 500);
  const sortBy = options.sortBy === 'date' || options.sortBy === 'createdAt' ? 'createdAt' : 'createdAt';
  const order = options.order === 'asc' ? 1 : -1;

  const isAdmin = await userIsAdmin(user || {});

  // Single-source queries use native DB pagination (status filter applied in Mongo).
  if (source === 'in_app') {
    const chatData = await chatService.listCalls(userId, {
      page,
      limit,
      isAdmin,
      search: options.search,
      status: options.status,
    });
    const results = (chatData.results || []).map((c) => ({
      source: 'in_app',
      id: c.id || c._id?.toString(),
      createdAt: c.createdAt,
      chatCall: c,
    }));
    return {
      results,
      page,
      limit,
      total: chatData.total ?? 0,
      totalPages: chatData.totalPages ?? (Math.ceil((chatData.total ?? 0) / limit) || 1),
    };
  }

  if (source === 'telephony') {
    const telephonyData = await callRecordService.listCallRecords({
      userId,
      isAdmin,
      page,
      limit,
      search: options.search,
      status: options.status,
      language: options.language,
      sortBy,
      order,
    });
    const results = (telephonyData.results || []).map((r) => ({
      source: 'telephony',
      id: r._id?.toString() || r.id,
      createdAt: r.createdAt,
      telephony: r,
    }));
    const total = telephonyData.total ?? results.length;
    return {
      results,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  const fetchTelephony = source === 'all';
  const fetchChat = source === 'all';

  /** Fetch enough rows from each source to merge-sort-slice for the requested page. */
  const mergeFetchLimit = Math.min(page * limit, 5000);

  const [telephonyData, chatData] = await Promise.all([
    fetchTelephony
      ? callRecordService.listCallRecords({
          userId,
          isAdmin,
          page: 1,
          limit: mergeFetchLimit,
          search: options.search,
          status: options.status,
          language: options.language,
          sortBy,
          order,
        })
      : Promise.resolve({ results: [], total: 0 }),
    fetchChat
      ? chatService.listCalls(userId, {
          page: 1,
          limit: mergeFetchLimit,
          isAdmin,
          search: options.search,
          status: options.status,
        })
      : Promise.resolve({ results: [], totalPages: 0, total: 0 }),
  ]);

  const telephonyRecords = telephonyData.results || [];
  const chatCalls = chatData.results || [];

  const unified = [];
  telephonyRecords.forEach((r) => {
    unified.push({
      source: 'telephony',
      id: r._id?.toString() || r.id,
      createdAt: r.createdAt,
      data: r,
    });
  });
  chatCalls.forEach((c) => {
    unified.push({
      source: 'in_app',
      id: c.id || c._id?.toString(),
      createdAt: c.createdAt,
      data: c,
    });
  });

  unified.sort((a, b) => {
    const da = new Date(a.createdAt || 0).getTime();
    const db = new Date(b.createdAt || 0).getTime();
    return order === -1 ? db - da : da - db;
  });

  let filtered = unified;

  if (options.status && options.status !== 'all') {
    const statusNorm = String(options.status).toLowerCase().replace(/-/g, '_');
    filtered = filtered.filter((u) => {
      const s =
        u.source === 'telephony'
          ? (u.data.status || 'unknown').toLowerCase().replace(/-/g, '_')
          : (u.data.status || '').toLowerCase().replace(/-/g, '_');
      if (statusNorm === 'missed') {
        if (isAdmin) {
          return MISSED_STATUS_VALUES.includes(s);
        }
        if (u.source === 'in_app') {
          return isIncomingMissedChatCall(u.data, userId);
        }
        if (u.source === 'telephony') {
          return isIncomingMissedTelephonyRecord(u.data);
        }
        return MISSED_STATUS_VALUES.includes(s);
      }
      if (statusNorm === 'declined') {
        return ['declined', 'rejected', 'busy'].includes(s);
      }
      return s === statusNorm;
    });
  }

  if (isAdmin && options.purpose && options.purpose !== 'all' && (source === 'all' || source === 'telephony')) {
    const purposeFilter = options.purpose;
    const purposeToCategory = (p) => {
      if (!p || !String(p).trim()) return 'Other';
      const x = String(p).toLowerCase();
      if (x.includes('job_application_verification') || x.includes('application_verification')) return 'Student/Candidate';
      if (x.includes('job_verification') || x.includes('job_posting_verification') || x.includes('recruiter'))
        return 'Job/Recruiter';
      return 'Other';
    };
    const matches = (cat) => {
      if (purposeFilter === 'all') return true;
      if (purposeFilter === 'job_recruiter') return cat === 'Job/Recruiter';
      if (purposeFilter === 'student_candidate') return cat === 'Student/Candidate';
      return true;
    };
    filtered = filtered.filter((u) => {
      if (u.source === 'in_app') return true;
      const cat = purposeToCategory(u.data.purpose);
      return matches(cat);
    });
  }

  const total = filtered.length;
  const telephonyTotal = telephonyData.total ?? telephonyRecords.length;
  const chatTotal = chatData.total ?? chatCalls.length;
  const combinedTotal =
    source === 'telephony' ? telephonyTotal : source === 'in_app' ? chatTotal : telephonyTotal + chatTotal;
  const totalPages = Math.ceil((options.status && options.status !== 'all' ? total : combinedTotal) / limit) || 1;
  const skip = (page - 1) * limit;
  const paginated = filtered.slice(skip, skip + limit);

  const results = paginated.map((u) => ({
    source: u.source,
    id: u.id,
    createdAt: u.createdAt,
    ...(u.source === 'telephony' ? { telephony: u.data } : { chatCall: u.data }),
  }));

  return {
    results,
    page,
    limit,
    total: options.status && options.status !== 'all' ? total : combinedTotal,
    totalPages,
  };
}

export {
  listUnifiedCalls,
};
