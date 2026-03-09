import callRecordService from './callRecord.service.js';
import * as chatService from './chat.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';

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

  const fetchTelephony = source === 'all' || source === 'telephony';
  const fetchChat = source === 'all' || source === 'in_app';

  const [telephonyData, chatData] = await Promise.all([
    fetchTelephony
      ? callRecordService.listCallRecords({
          userId,
          isAdmin,
          page: 1,
          limit: 10000,
          search: options.search,
          status: options.status,
          language: options.language,
          sortBy,
          order,
        })
      : Promise.resolve({ results: [], total: 0 }),
    fetchChat
      ? chatService.listCalls(userId, { page: 1, limit: 10000, isAdmin })
      : Promise.resolve({ results: [], totalPages: 0 }),
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
  const totalPages = Math.ceil(total / limit) || 1;
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
    total,
    totalPages,
  };
}

export default {
  listUnifiedCalls,
};
