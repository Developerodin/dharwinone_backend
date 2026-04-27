import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import ActivityLog from '../models/activityLog.model.js';
import Job from '../models/job.model.js';
import config from '../config/config.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import * as activityLogService from './activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { logReferralEvent } from './referralAttribution.service.js';
import logger from '../config/logger.js';

const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who may see the full org referral-lead list (else scoped to their own `referredByUserId`).
 * - `candidates.manage`: ATS admins
 * - `interviews.manage`: same org-wide need as the Schedule Interview jobs/recruiters pick lists
 * @param {import('express').Request} req
 */
/**
 * Same access as referral lead list row: org-wide readers, or current lead referrer.
 * @param {import('express').Request} req
 * @param {string} candidateId
 */
export const assertReferralLeadViewAccess = async (req, candidateId) => {
  const c = await Employee.findById(candidateId).select('referredByUserId').lean();
  if (!c) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Candidate not found');
  }
  if (canSeeAllReferralLeads(req)) {
    return;
  }
  if (c.referredByUserId && String(c.referredByUserId) === String(req.user._id)) {
    return;
  }
  throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden');
};

/**
 * Audit trail of admin attribution overrides for a lead (from ActivityLog).
 * @param {import('express').Request} req
 */
export const getReferralAttributionOverrideHistory = async (req) => {
  const { candidateId } = req.params;
  await assertReferralLeadViewAccess(req, candidateId);
  const rows = await ActivityLog.find({
    action: ActivityActions.REFERRAL_ATTRIBUTION_OVERRIDE,
    entityType: EntityTypes.CANDIDATE,
    entityId: String(candidateId),
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate({ path: 'actor', select: 'name email' })
    .lean();

  const idSet = new Set();
  for (const r of rows) {
    const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
    if (m.previousReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.previousReferredByUserId))) {
      idSet.add(String(m.previousReferredByUserId));
    }
    if (m.newReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.newReferredByUserId))) {
      idSet.add(String(m.newReferredByUserId));
    }
  }
  const ids = [...idSet];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name email').lean() : [];
  const uMap = new Map(
    users.map((u) => [u._id.toString(), { id: u._id.toString(), name: u.name, email: u.email }])
  );

  const shapeActor = (r) => {
    const a = r.actor;
    if (a && typeof a === 'object' && (a.name !== undefined || a.email !== undefined)) {
      return {
        id: (a._id || a.id).toString(),
        name: a.name,
        email: a.email,
      };
    }
    return { id: String(r.actor), name: 'Unknown', email: undefined };
  };

  return {
    results: rows.map((r) => {
      const m = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
      const prevId =
        m.previousReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.previousReferredByUserId))
          ? String(m.previousReferredByUserId)
          : null;
      const newId =
        m.newReferredByUserId && mongoose.Types.ObjectId.isValid(String(m.newReferredByUserId))
          ? String(m.newReferredByUserId)
          : null;
      return {
        id: r._id.toString(),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        actor: shapeActor(r),
        previousReferredBy: prevId ? uMap.get(prevId) || { id: prevId, name: 'Unknown', email: undefined } : null,
        newReferredBy: newId ? uMap.get(newId) || { id: newId, name: 'Unknown', email: undefined } : null,
        reason: m.reason != null ? String(m.reason) : '',
      };
    }),
  };
};

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

/**
 * Normalize a user ref (ObjectId, subdoc, string, populated lean doc) to a 24-hex id string.
 * Dot-notation `populate` on `referralLastOverride.*` is unreliable for single nested subdocs, so we resolve by id.
 * @param {unknown} v
 * @returns {string|null}
 */
const asObjectIdString = (v) => {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v._id != null) return String(v._id);
    if (v.id != null && mongoose.isValidObjectId(v.id)) return String(v.id);
  }
  if (typeof v === 'string' && mongoose.isValidObjectId(v)) return v;
  try {
    if (typeof v?.toString === 'function' && (v._bsontype === 'ObjectID' || v.constructor?.name === 'ObjectId')) {
      const s = v.toString();
      if (s && mongoose.isValidObjectId(s)) return s;
    }
  } catch {
    // ignore
  }
  try {
    const s = v.toString?.();
    if (s && mongoose.isValidObjectId(s)) return s;
  } catch {
    // ignore
  }
  return null;
};

/**
 * @param {object|null|undefined} rlo
 * @returns {Promise<object|null>}
 */
const shapeReferralLastOverride = async (rlo) => {
  if (!rlo) return null;
  if (
    !rlo.overriddenAt &&
    !rlo.overriddenBy &&
    !rlo.previousReferredByUserId &&
    !rlo.newReferredByUserId
  ) {
    return null;
  }
  const idBy = asObjectIdString(rlo.overriddenBy);
  const idPrev = asObjectIdString(rlo.previousReferredByUserId);
  const idNew = asObjectIdString(rlo.newReferredByUserId);
  const unique = [...new Set([idBy, idPrev, idNew].filter(Boolean))];
  const users = unique.length
    ? await User.find({ _id: { $in: unique } })
        .select('name email')
        .lean()
    : [];
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  const toSummary = (idStr) => {
    if (!idStr) return null;
    const u = byId.get(idStr);
    if (u) return { id: u._id.toString(), name: u.name, email: u.email };
    return { id: idStr, name: 'Unknown', email: undefined };
  };
  return {
    reason: rlo.reason != null ? String(rlo.reason) : '',
    overriddenAt: rlo.overriddenAt ? new Date(rlo.overriddenAt).toISOString() : null,
    overriddenByUser: toSummary(idBy),
    previousReferredBy: toSummary(idPrev),
    newReferredBy: toSummary(idNew),
  };
};

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

  const referralLastOverride = await shapeReferralLastOverride(o.referralLastOverride);

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
    referralLastOverride,
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

const usersCollectionName = () => User.collection.collectionName;
const jobsCollectionName = () => Job.collection.collectionName;

/**
 * Referral rows are Candidate (`Employee`) documents with denormalized name/email.
 * They always have `owner` → portal User. After user hard-delete, cascade should remove the candidate;
 * if anything is missed (legacy data, partial failure), the owner id can point at a deleted user.
 * These stages restrict lists/stats/export to candidates whose owner still exists in `users`.
 */
const referralLeadsRequireExistingOwnerStages = () => {
  const from = usersCollectionName();
  return [
    {
      $lookup: {
        from,
        localField: 'owner',
        foreignField: '_id',
        as: '__portalOwnerExists',
      },
    },
    { $match: { '__portalOwnerExists.0': { $exists: true } } },
    { $project: { __portalOwnerExists: 0 } },
  ];
};

/** Match shapeLeadRow: single embedded docs for referrer + job (like .populate().lean()). */
const referralLeadsPopulateReferrerAndJobStages = () => {
  const usersColl = usersCollectionName();
  const jobsColl = jobsCollectionName();
  return [
    {
      $lookup: {
        from: usersColl,
        localField: 'referredByUserId',
        foreignField: '_id',
        as: 'referredByUserIdArr',
      },
    },
    {
      $addFields: {
        referredByUserId: { $arrayElemAt: ['$referredByUserIdArr', 0] },
      },
    },
    { $project: { referredByUserIdArr: 0 } },
    {
      $lookup: {
        from: jobsColl,
        localField: 'referralJobId',
        foreignField: '_id',
        as: 'referralJobIdArr',
      },
    },
    {
      $addFields: {
        referralJobId: { $arrayElemAt: ['$referralJobIdArr', 0] },
      },
    },
    { $project: { referralJobIdArr: 0 } },
  ];
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

  const pipeline = [
    { $match: match },
    ...referralLeadsRequireExistingOwnerStages(),
    ...referralLeadsPopulateReferrerAndJobStages(),
    { $sort: { referredAt: -1, _id: -1 } },
    { $limit: limit + 1 },
  ];

  const rows = await Employee.aggregate(pipeline);

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

  const ownerStages = referralLeadsRequireExistingOwnerStages();

  const [totalArr, byStatus, topRef] = await Promise.all([
    Employee.aggregate([{ $match: match }, ...ownerStages, { $count: 'c' }]),
    Employee.aggregate([
      { $match: match },
      ...ownerStages,
      { $group: { _id: '$referralPipelineStatus', count: { $sum: 1 } } },
    ]),
    Employee.aggregate([
      { $match: match },
      ...ownerStages,
      { $group: { _id: '$referredByUserId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]),
  ]);

  const totalAgg = totalArr[0]?.c ?? 0;

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
  const rows = await Employee.aggregate([
    { $match: match },
    ...referralLeadsRequireExistingOwnerStages(),
    ...referralLeadsPopulateReferrerAndJobStages(),
    { $sort: { referredAt: -1 } },
    { $limit: cap },
  ]);

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
  const reasonNorm = String(reason ?? '')
    .trim()
    .slice(0, 200);
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
    reason: reasonNorm,
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
      claimStage: 'attribution_override',
    },
    req
  );
  logReferralEvent('referral_attribution_overridden', {
    candidateId: String(candidateId),
    previousReferredByUserId: String(prev),
    newReferredByUserId: String(newReferredByUserId),
  });

  await c.populate([{ path: 'referredByUserId', select: 'name email' }]);
  return shapeLeadRow(c);
};
