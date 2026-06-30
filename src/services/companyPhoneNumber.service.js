import httpStatus from 'http-status';
import mongoose from 'mongoose';
import CompanyPhoneNumber from '../models/companyPhoneNumber.model.js';
import User from '../models/user.model.js';
import Department from '../models/department.model.js';
import TeamGroup from '../models/teamGroup.model.js';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import { getDirectoryHiddenUserIds, viewerSeesHiddenUsers } from '../utils/platformAccess.util.js';

function tenantIdForUser(user) {
  return user?.tenantId || user?._id || user?.id;
}

function toE164Phone(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function normalizeCalledNumber(raw) {
  const e164 = toE164Phone(raw);
  if (e164) return e164;
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function mapCapabilities(raw) {
  if (!raw) return { voice: true, sms: false };
  return {
    voice: Boolean(raw.voice ?? raw.voiceEnabled ?? true),
    sms: Boolean(raw.sms ?? raw.smsEnabled ?? false),
  };
}

function mapProviderOwnedRow(row, provider) {
  const phone = normalizeCalledNumber(row.number || row.phoneNumber || '');
  return {
    provider,
    phoneNumber: phone,
    friendlyName: row.friendlyName || row.alias || phone,
    twilioSid: row.sid || row.id || '',
    capabilities: mapCapabilities(row.capabilities || row.capability),
  };
}

/**
 * Resolve inbound PSTN routing: active number row → assigned user, else env fallback.
 * @param {string} calledNumber
 * @returns {Promise<string>} Mongo User id or ''
 */
export async function resolveInboundUserIdForCalledNumber(calledNumber) {
  const phone = normalizeCalledNumber(calledNumber);
  if (!phone) return '';

  if (mongoose.connection.readyState === 1) {
    try {
      const mapping = await CompanyPhoneNumber.findOne({
        phoneNumber: phone,
        isActive: true,
      })
        .select('assignedTo')
        .lean();

      if (mapping?.assignedTo) {
        return String(mapping.assignedTo);
      }
    } catch (err) {
      logger.warn('[CompanyPhoneNumber] inbound lookup failed', { phone, err: err?.message });
    }
  }

  const fallback = (config.twilio?.inboundDefaultUser || '').trim();
  if (fallback) {
    logger.info('[CompanyPhoneNumber] inbound fallback to TWILIO_INBOUND_DEFAULT_USER', { phone });
    return fallback;
  }

  return '';
}

export async function listCompanyPhoneNumbers(user, filters = {}) {
  const tenantId = tenantIdForUser(user);
  const query = { tenantId };

  if (filters.isActive === 'true') query.isActive = true;
  if (filters.isActive === 'false') query.isActive = false;
  if (filters.assignedTo) query.assignedTo = filters.assignedTo;
  if (filters.departmentId) query.departmentId = filters.departmentId;
  if (filters.teamId) query.teamId = filters.teamId;
  if (filters.unassigned === 'true') query.assignedTo = null;

  const q = String(filters.q || '').trim();
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ phoneNumber: re }, { friendlyName: re }];
  }

  const rows = await CompanyPhoneNumber.find(query)
    .sort({ phoneNumber: 1 })
    .populate('assignedTo', 'name email')
    .populate('departmentId', 'name')
    .populate('teamId', 'name')
    .lean();

  return { numbers: rows, total: rows.length };
}

export async function syncCompanyPhoneNumbersFromProvider(user) {
  const tenantId = tenantIdForUser(user);
  const telephonyService = (await import('./telephony.service.js')).default;
  const provider = telephonyService.getProviderName();
  const result = await telephonyService.listOwnedNumbers({ limit: 200, offset: 0 });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to sync numbers from telephony provider');
  }

  let created = 0;
  let updated = 0;
  const providerRows = result.numbers || [];

  for (const row of providerRows) {
    const mapped = mapProviderOwnedRow(row, provider);
    if (!mapped.phoneNumber) continue;

    const existing = await CompanyPhoneNumber.findOne({
      tenantId,
      phoneNumber: mapped.phoneNumber,
    });

    if (!existing) {
      await CompanyPhoneNumber.create({
        tenantId,
        provider: mapped.provider,
        phoneNumber: mapped.phoneNumber,
        friendlyName: mapped.friendlyName,
        twilioSid: mapped.twilioSid,
        capabilities: mapped.capabilities,
        isActive: true,
        createdBy: user._id || user.id,
      });
      created += 1;
    } else {
      existing.provider = mapped.provider;
      if (mapped.twilioSid) existing.twilioSid = mapped.twilioSid;
      if (!existing.friendlyName && mapped.friendlyName) existing.friendlyName = mapped.friendlyName;
      existing.capabilities = mapped.capabilities;
      await existing.save();
      updated += 1;
    }
  }

  return { created, updated, total: providerRows.length, provider };
}

export async function recordCompanyPhoneNumberPurchase(user, purchasePayload = {}) {
  const tenantId = tenantIdForUser(user);
  const telephonyService = (await import('./telephony.service.js')).default;
  const provider = telephonyService.getProviderName();
  const phoneNumber = normalizeCalledNumber(
    purchasePayload.phoneNumberE164 || purchasePayload.number || purchasePayload.phoneNumber,
  );
  if (!phoneNumber) return null;

  const payload = {
    tenantId,
    provider,
    phoneNumber,
    friendlyName: purchasePayload.friendlyName || phoneNumber,
    twilioSid: purchasePayload.providerSid || purchasePayload.sid || '',
    capabilities: mapCapabilities(purchasePayload.capabilities),
    isActive: true,
    createdBy: user._id || user.id,
  };

  const existing = await CompanyPhoneNumber.findOne({ tenantId, phoneNumber });
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }

  return CompanyPhoneNumber.create(payload);
}

export async function updateCompanyPhoneNumberById(user, id, patch) {
  const tenantId = tenantIdForUser(user);
  const doc = await CompanyPhoneNumber.findOne({ _id: id, tenantId });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Company phone number not found');

  if (patch.friendlyName !== undefined) doc.friendlyName = String(patch.friendlyName || '').trim();

  if (patch.isActive !== undefined) doc.isActive = Boolean(patch.isActive);

  if (patch.assignedTo !== undefined) {
    if (patch.assignedTo === null || patch.assignedTo === '') {
      doc.assignedTo = null;
    } else {
      const assignee = await User.findById(patch.assignedTo).select('_id');
      if (!assignee) throw new ApiError(httpStatus.BAD_REQUEST, 'Assigned user not found');
      doc.assignedTo = assignee._id;
    }
  }

  if (patch.departmentId !== undefined) {
    if (!patch.departmentId) doc.departmentId = null;
    else {
      const dept = await Department.findById(patch.departmentId).select('_id');
      if (!dept) throw new ApiError(httpStatus.BAD_REQUEST, 'Department not found');
      doc.departmentId = dept._id;
    }
  }

  if (patch.teamId !== undefined) {
    if (!patch.teamId) doc.teamId = null;
    else {
      const team = await TeamGroup.findById(patch.teamId).select('_id');
      if (!team) throw new ApiError(httpStatus.BAD_REQUEST, 'Team not found');
      doc.teamId = team._id;
    }
  }

  await doc.save();
  return doc.populate([
    { path: 'assignedTo', select: 'name email' },
    { path: 'departmentId', select: 'name' },
    { path: 'teamId', select: 'name' },
  ]);
}

/** Numbers assigned to a user for caller-id / inbound context. */
export async function listActiveNumbersForUser(userId) {
  return CompanyPhoneNumber.find({ assignedTo: userId, isActive: true })
    .sort({ phoneNumber: 1 })
    .lean();
}

async function buildAssignableUsersQuery(requester) {
  const query = {
    status: { $in: ['active', 'pending'] },
    email: { $not: /\.noreply@dharwin\.offers\.local$/i },
  };
  if (requester && !viewerSeesHiddenUsers(requester)) {
    const hiddenIds = await getDirectoryHiddenUserIds();
    if (hiddenIds.length > 0) {
      query._id = { $nin: hiddenIds };
    }
  }
  return query;
}

/** Roster of org users with assigned company work number (Settings number tab). */
export async function listUserPhoneAssignments(adminUser) {
  const tenantId = tenantIdForUser(adminUser);
  const users = await User.find(await buildAssignableUsersQuery(adminUser))
    .select('name email roleIds')
    .sort({ name: 1 })
    .limit(500)
    .lean();

  const Role = (await import('../models/role.model.js')).default;
  const allRoleIds = [...new Set(users.flatMap((u) => u.roleIds || []).map((id) => String(id)))];
  const roleDocs =
    allRoleIds.length > 0 ? await Role.find({ _id: { $in: allRoleIds } }).select('name').lean() : [];
  const roleNameById = new Map(roleDocs.map((r) => [String(r._id), r.name]));

  const assignedRows = await CompanyPhoneNumber.find({ tenantId, assignedTo: { $ne: null } })
    .select('phoneNumber friendlyName assignedTo isActive')
    .lean();
  const assignedByUserId = new Map();
  for (const row of assignedRows) {
    const uid = String(row.assignedTo);
    if (!assignedByUserId.has(uid)) assignedByUserId.set(uid, row);
  }

  const numbers = await CompanyPhoneNumber.find({ tenantId }).sort({ phoneNumber: 1 }).lean();

  const roster = users.map((u) => {
    const uid = String(u._id);
    const roleNames = (u.roleIds || []).map((rid) => roleNameById.get(String(rid))).filter(Boolean);
    const assignedRow = assignedByUserId.get(uid);
    return {
      userId: uid,
      fullName: u.name || u.email || uid,
      email: u.email || '',
      roleLabel: roleNames.length ? roleNames.join(' · ') : '—',
      companyPhoneNumberId: assignedRow ? String(assignedRow._id) : null,
      companyPhoneNumber: assignedRow?.phoneNumber || '',
    };
  });

  return {
    users: roster,
    numbers: numbers.map((n) => ({
      _id: String(n._id),
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName || '',
      isActive: Boolean(n.isActive),
      assignedToUserId: n.assignedTo ? String(n.assignedTo) : null,
    })),
  };
}

/** Assign one registry number to a user (clears any prior number on that user). */
export async function assignPhoneNumberToUser(adminUser, { userId, companyPhoneNumberId }) {
  const tenantId = tenantIdForUser(adminUser);
  const user = await User.findOne({ _id: userId, ...(await buildAssignableUsersQuery(adminUser)) }).select('_id');
  if (!user) throw new ApiError(httpStatus.BAD_REQUEST, 'User not found');

  await CompanyPhoneNumber.updateMany({ tenantId, assignedTo: userId }, { $set: { assignedTo: null } });

  if (!companyPhoneNumberId) {
    return { userId: String(userId), companyPhoneNumberId: null, companyPhoneNumber: '' };
  }

  const doc = await CompanyPhoneNumber.findOne({ _id: companyPhoneNumberId, tenantId });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Company phone number not found');

  doc.assignedTo = user._id;
  await doc.save();

  return {
    userId: String(userId),
    companyPhoneNumberId: String(doc._id),
    companyPhoneNumber: doc.phoneNumber,
  };
}
