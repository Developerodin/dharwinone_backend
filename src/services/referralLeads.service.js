import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import Job from '../models/job.model.js';
import config from '../config/config.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import * as activityLogService from './activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import logger from '../config/logger.js';

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who may see the full org referral-lead list (else scoped to their own `referredByUserId`).
 * - `candidates.manage`: ATS admins
 * - `interviews.manage`: same org-wide need as the Schedule Interview jobs/recruiters pick lists
 * @param {import('express').Request} req
 */
export const canSeeAllReferralLeads = (req) => {
  const p = req.authContext?.permissions;
  if (!p) return false;
  if (p.has('candidates.manage')) return true;
  if (p.has('interviews.manage')) return true;
  return false;
};

/**
 * Build Mongo match for referral leads (referred candidates; not restricted by Candidate-role owner roster).
 * @param {object} opts
 * @param {object} opts.user
 * @param {boolean} opts.canSeeAll
 * @param {object} opts.query - parsed query string
 */
export const buildReferralLeadsMatch = async (opts) => {
  const { user, canSeeAll, query } = opts;
  const mongo = {
    referredByUserId: { $exists: true, $ne: null },
  };

  if (!canSeeAll) {
    mongo.referredByUserId = user._id;
  } else if (query.referredByUserId && mongoose.Types.ObjectId.isValid(String(query.referredByUserId))) {
    mongo.referredByUserId = new mongoose.Types.ObjectId(String(query.referredByUserId));
  }

  if (query.referralContext && ['SHARE_CANDIDATE_ONBOARD', 'JOB_APPLY'].includes(query.referralContext)) {
    mongo.referralContext = query.referralContext;
  }

  if (query.referralPipelineStatus) {
    mongo.referralPipelineStatus = query.referralPipelineStatus;
  }

  if (query.from || query.to) {
    mongo.referredAt = {};
    if (query.from) {
      mongo.referredAt.$gte = new Date(query.from);
    }
    if (query.to) {
      const t = new Date(query.to);
      t.setHours(23, 59, 59, 999);
      mongo.referredAt.$lte = t;
    }
  }

  if (query.search && String(query.search).trim()) {
    const q = escapeRegex(String(query.search).trim());
    mongo.$and = (mongo.$and || []).concat([
      {
        $or: [
          { fullName: { $regex: q, $options: 'i' } },
          { email: { $regex: q, $options: 'i' } },
        ],
      },
    ]);
  }

  // Do not filter by `owner` ∈ Candidate-role users (unlike listCandidates). Referred
  // signups from share-onboarding and public/invite often have Student-only or no
  // `roleIds` until activation; they still have a Candidate document and must appear here.

  return mongo;
};

const selectList =
  'fullName email profilePicture referredByUserId referralContext referralJobId referralJobTitle referredAt referralBatchId referralPipelineStatus attributionLockedAt referralAttributionAnonymised referralLastOverride createdAt';

/**
 * @param {import('mongoose').Document|object} row
 */
const shapeLeadRow = async (row) => {
  const o = row.toObject ? row.toObject() : { ...row };
  const ref = o.referredByUserId;
  let referredBy = null;
  if (ref && typeof ref === 'object' && (ref.name || ref.email)) {
    referredBy = { id: (ref._id || ref.id).toString(), name: ref.name, email: ref.email };
  } else if (ref) {
    const u = await User.findById(ref).select('name email').lean();
    if (u) referredBy = { id: u._id.toString(), name: u.name, email: u.email };
  }
  let job = null;
  if (o.referralJobId && typeof o.referralJobId === 'object' && o.referralJobId.title) {
    job = {
      id: (o.referralJobId._id || o.referralJobId.id).toString(),
      title: o.referralJobId.title,
    };
  } else if (o.referralJobId) {
    const j = await Job.findById(o.referralJobId).select('title').lean();
    if (j) job = { id: String(o.referralJobId), title: j.title };
  } else if (o.referralJobTitle) {
    job = { title: o.referralJobTitle };
  }
  if (o.profilePicture?.key) {
    try {
      o.profilePicture.url = await generatePresignedDownloadUrl(o.profilePicture.key, 7 * 24 * 3600);
    } catch (e) {
      logger.warn('referralLeads presign profile:', e?.message);
    }
  }
  return {
    id: o._id?.toString?.() || o.id,
    fullName: o.fullName,
    email: o.email,
    profilePicture: o.profilePicture,
    referredBy,
    referralContext: o.referralContext,
    referredAt: o.referredAt,
    attributionLockedAt: o.attributionLockedAt,
    referralAttributionAnonymised: o.referralAttributionAnonymised,
    referralPipelineStatus: o.referralPipelineStatus,
    referralBatchId: o.referralBatchId,
    job,
    referralLastOverride: o.referralLastOverride,
    createdAt: o.createdAt,
  };
};

/**
 * Cursor: base64url JSON { referredAt ISO, id }
 */
const encodeCursor = (referredAt, id) =>
  Buffer.from(
    JSON.stringify({
      referredAt: referredAt?.toISOString?.() || new Date(referredAt).toISOString(),
      id: String(id),
    }),
    'utf8'
  ).toString('base64url');

const decodeCursor = (cursor) => {
  try {
    const j = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!j.id || !j.referredAt) return null;
    return { referredAt: new Date(j.referredAt), id: String(j.id) };
  } catch {
    return null;
  }
};

export const listReferralLeads = async (req) => {
  const canSeeAll = canSeeAllReferralLeads(req);
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100);
  const baseMatch = await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q });
  const match = { ...baseMatch };
  if (baseMatch.$and) {
    match.$and = [...baseMatch.$and];
  }
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      const oid = new mongoose.Types.ObjectId(c.id);
      const cursorClause = {
        $or: [
          { referredAt: { $lt: c.referredAt } },
          { $and: [{ referredAt: c.referredAt }, { _id: { $lt: oid } }] },
        ],
      };
      match.$and = [...(match.$and || []), cursorClause];
    }
  }

  const rows = await Employee.find(match)
    .sort({ referredAt: -1, _id: -1 })
    .limit(limit + 1)
    .select(selectList)
    .populate({ path: 'referredByUserId', select: 'name email' })
    .populate({ path: 'referralJobId', select: 'title' })
    .lean();

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && slice.length > 0) {
    const last = slice[slice.length - 1];
    nextCursor = encodeCursor(last.referredAt, last._id);
  }

  const results = await Promise.all(slice.map((r) => shapeLeadRow(r)));
  return {
    results,
    nextCursor,
    hasMore,
    staleDataWarning: false,
  };
};

const CONVERTED_STATUSES = ['applied', 'in_review', 'hired'];
const PENDING_STATUSES = ['pending', 'profile_complete'];

export const getReferralLeadsStats = async (req) => {
  const canSeeAll = canSeeAllReferralLeads(req);
  const q = req.query || {};
  const match = await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q });

  const [totalAgg, byStatus, topRef] = await Promise.all([
    Employee.countDocuments(match),
    Employee.aggregate([
      { $match: match },
      { $group: { _id: '$referralPipelineStatus', count: { $sum: 1 } } },
    ]),
    Employee.aggregate([
      { $match: match },
      { $group: { _id: '$referredByUserId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]),
  ]);

  const byStatusMap = Object.fromEntries(byStatus.map((x) => [x._id || 'null', x.count]));
  let converted = 0;
  let pending = 0;
  const hired = byStatusMap.hired || 0;
  for (const s of CONVERTED_STATUSES) {
    converted += byStatusMap[s] || 0;
  }
  for (const s of PENDING_STATUSES) {
    pending += byStatusMap[s] || 0;
  }

  const period = q.from || q.to ? 'filtered' : 'all_time';
  let topReferrer = null;
  if (topRef.length > 0 && topRef[0]._id) {
    const u = await User.findById(topRef[0]._id).select('name').lean();
    topReferrer = {
      userId: String(topRef[0]._id),
      name: u?.name || 'Unknown',
      count: topRef[0].count,
      period,
    };
  }

  const conversionRate = totalAgg > 0 ? Math.round((converted / totalAgg) * 1000) / 10 : 0;

  return {
    totalReferrals: totalAgg,
    converted,
    conversionRate,
    pending,
    hired,
    topReferrer,
    leaderboard: [],
  };
};

export const exportReferralLeadsCsv = async (req, res) => {
  const canSeeAll = canSeeAllReferralLeads(req);
  const q = { ...req.query, search: undefined };
  const match = await buildReferralLeadsMatch({ user: req.user, canSeeAll, query: q });
  const cap = 5000;
  const rows = await Employee.find(match)
    .sort({ referredAt: -1 })
    .limit(cap)
    .select(
      'fullName email referredByUserId referralContext referralJobId referralJobTitle referredAt referralBatchId referralJti referralPipelineStatus attributionLockedAt'
    )
    .populate('referredByUserId', 'name email')
    .populate('referralJobId', 'title')
    .lean();

  const orgId = config.referral?.defaultOrgId || 'default';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="referral-leads.csv"');
  const header = [
    'candidate_id',
    'candidate_name',
    'candidate_email',
    'referrer_id',
    'referrer_name',
    'referrer_role',
    'referral_context',
    'job_id',
    'job_title',
    'referral_jti',
    'batch_id',
    'status',
    'referred_at',
    'attribution_locked_at',
    'org_id',
  ].join(',');
  res.write(`${header}\n`);
  for (const r of rows) {
    const ref = r.referredByUserId;
    const rid = ref?._id ? String(ref._id) : r.referredByUserId ? String(r.referredByUserId) : '';
    const rname = (ref && ref.name) || '';
    const line = [
      r._id,
      r.fullName,
      r.email,
      rid,
      rname,
      '',
      r.referralContext || '',
      r.referralJobId?._id || r.referralJobId || '',
      r.referralJobId?.title || r.referralJobTitle || '',
      r.referralJti || '',
      r.referralBatchId || '',
      r.referralPipelineStatus || '',
      r.referredAt ? new Date(r.referredAt).toISOString() : '',
      r.attributionLockedAt ? new Date(r.attributionLockedAt).toISOString() : '',
      orgId,
    ];
    res.write(`${line.map((x) => csvCell(x)).join(',')}\n`);
  }
  res.end();

  try {
    await activityLogService.createActivityLog(
      req.user.id,
      ActivityActions.REFERRAL_LEADS_EXPORT,
      EntityTypes.CANDIDATE,
      req.user.id,
      { rowCount: rows.length, filters: { ...q } },
      req
    );
  } catch (e) {
    logger.warn('referral export activity log', e);
  }
};

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const overrideReferralAttribution = async (req) => {
  const { candidateId } = req.params;
  const { newReferredByUserId, reason } = req.body;
  if (!reason || !String(reason).trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Reason is required');
  }
  if (!mongoose.Types.ObjectId.isValid(newReferredByUserId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid new referrer id');
  }
  const c = await Employee.findById(candidateId);
  if (!c) throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  if (!c.referredByUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Candidate has no referral to override');
  }

  const prev = c.referredByUserId;
  c.referralLastOverride = {
    previousReferredByUserId: prev,
    newReferredByUserId,
    reason: String(reason).trim().slice(0, 200),
    overriddenBy: req.user._id,
    overriddenAt: new Date(),
  };
  c.referredByUserId = newReferredByUserId;
  await c.save();

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.REFERRAL_ATTRIBUTION_OVERRIDE,
    EntityTypes.CANDIDATE,
    candidateId,
    {
      previousReferredByUserId: String(prev),
      newReferredByUserId: String(newReferredByUserId),
      reason: c.referralLastOverride.reason,
    },
    req
  );

  await c.populate([{ path: 'referredByUserId', select: 'name email' }]);
  return shapeLeadRow(c);
};
