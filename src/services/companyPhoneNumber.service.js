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

function currentTelephonyProvider() {
  return config.telephony?.provider === 'twilio' ? 'twilio' : 'plivo';
}

/** Dropdown registry query: active-provider numbers + any assigned row (cross-provider visibility). */
export function buildAssignableNumbersQuery(tenantId, activeProvider) {
  const providerClauses =
    activeProvider === 'twilio'
      ? [{ provider: 'twilio' }, { provider: { $exists: false } }, { provider: null }]
      : [{ provider: activeProvider }];

  return {
    tenantId,
    $or: [...providerClauses, { assignedTo: { $ne: null } }],
  };
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

  const buyerId = user._id || user.id;
  const payload = {
    tenantId,
    provider,
    phoneNumber,
    friendlyName: purchasePayload.friendlyName || phoneNumber,
    twilioSid: purchasePayload.providerSid || purchasePayload.sid || '',
    capabilities: mapCapabilities(purchasePayload.capabilities),
    isActive: true,
    createdBy: buyerId,
  };

  // Direct buy assigns the number to the buyer so My Numbers + inbound work.
  if (purchasePayload.assignedTo !== undefined) {
    payload.assignedTo = purchasePayload.assignedTo || null;
  } else {
    payload.assignedTo = buyerId;
  }

  if (purchasePayload.isoCountry) {
    payload.isoCountry = String(purchasePayload.isoCountry).toUpperCase();
  }
  if (purchasePayload.numberType) {
    payload.numberType = String(purchasePayload.numberType).toLowerCase();
  }
  if (purchasePayload.retailMonthlyPrice != null) {
    payload.retailMonthlyPrice = Number(purchasePayload.retailMonthlyPrice);
  }
  if (purchasePayload.subscriptionId) {
    payload.subscriptionId = purchasePayload.subscriptionId;
  }

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
  const numbers = await CompanyPhoneNumber.find({ assignedTo: userId, isActive: true })
    .sort({ phoneNumber: 1 })
    .lean();

  const { mapSubscriptionsByCompanyPhoneNumberIds } = await import('./numberSubscription.service.js');
  const subMap = await mapSubscriptionsByCompanyPhoneNumberIds(numbers.map((n) => n._id));

  return numbers.map((n) => {
    const sub = subMap.get(String(n._id));
    return {
      ...n,
      id: String(n._id),
      subscriptionStatus: sub?.status || null,
      paymentStatus: sub?.paymentStatus || null,
      retailMonthlyPrice:
        n.retailMonthlyPrice != null ? n.retailMonthlyPrice : sub?.retailMonthlyPrice ?? null,
      subscriptionId: sub?._id ? String(sub._id) : n.subscriptionId ? String(n.subscriptionId) : null,
      currentPeriodEnd: sub?.currentPeriodEnd || null,
    };
  });
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

  const activeProvider = currentTelephonyProvider();
  const numbers = await CompanyPhoneNumber.find(buildAssignableNumbersQuery(tenantId, activeProvider))
    .sort({ phoneNumber: 1 })
    .lean();

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

/**
 * Buy Number orchestration (payment skipped):
 * regulatory gate → conflict check → Twilio purchase → assign buyer → create monthly subscription.
 *
 * @param {object} user
 * @param {{ number: string, countryIso: string, type?: string, friendlyName?: string }} body
 */
export async function purchaseNumberForUser(user, body = {}) {
  const { REQUIRES_VERIFICATION_MESSAGE } = await import('../utils/numberRegulatory.util.js');
  const numberPricingService = (await import('./numberPricing.service.js')).default;
  const numberSubscriptionService = await import('./numberSubscription.service.js');
  const telephonyService = (await import('./telephony.service.js')).default;
  const twilioService = (await import('./twilio.service.js')).default;

  const countryIso = String(body.countryIso || '').trim().toUpperCase();
  if (!countryIso || !/^[A-Z]{2}$/.test(countryIso)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'countryIso is required (ISO 3166-1 alpha-2).');
  }

  const rawType = String(body.type || 'local').toLowerCase().replace(/[\s_-]/g, '');
  const numberType =
    rawType === 'tollfree' || rawType === 'tollFree' ? 'tollfree' : rawType === 'mobile' ? 'mobile' : 'local';

  const phoneNumber = normalizeCalledNumber(body.number || body.phoneNumber);
  if (!phoneNumber) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A valid number is required.');
  }

  const compliance = await twilioService.resolveNumberCompliance({
    countryIso,
    numberType,
    phoneNumber,
    addressRequirements: body.addressRequirements,
  });
  if (compliance.requiresVerification) {
    throw new ApiError(httpStatus.BAD_REQUEST, REQUIRES_VERIFICATION_MESSAGE, true, '', {
      errorCode: 'REQUIRES_VERIFICATION',
      details: {
        countryIso,
        numberType,
        phoneNumber,
        requiresVerification: true,
        addressRequirements: compliance.addressRequirements,
        regulationCount: compliance.regulations?.length ?? 0,
      },
    });
  }

  const existingActive = await CompanyPhoneNumber.findOne({ phoneNumber, isActive: true }).lean();
  if (existingActive) {
    throw new ApiError(httpStatus.CONFLICT, 'That number is already provisioned.', true, '', {
      errorCode: 'NUMBER_ALREADY_PROVISIONED',
    });
  }

  const retail = await numberPricingService.resolveRetailPrice({ countryIso, numberType });

  const result = await telephonyService.buyNumber(phoneNumber);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to buy number');
  }

  const buyerId = user._id || user.id;
  const companyNumber = await recordCompanyPhoneNumberPurchase(user, {
    ...result,
    assignedTo: buyerId,
    isoCountry: countryIso,
    numberType,
    retailMonthlyPrice: retail.monthlyPriceUsd,
  });

  const subscription = await numberSubscriptionService.createWaivedSubscription({
    tenantId: tenantIdForUser(user),
    userId: buyerId,
    companyPhoneNumberId: companyNumber?._id,
    phoneNumber: companyNumber?.phoneNumber || result.phoneNumberE164 || phoneNumber,
    twilioSid: result.providerSid || '',
    retailMonthlyPrice: retail.monthlyPriceUsd,
    currency: retail.currency,
  });

  if (companyNumber) {
    companyNumber.subscriptionId = subscription._id;
    await companyNumber.save();
  }

  logger.info('[BuyNumber] purchased', {
    phoneNumber: companyNumber?.phoneNumber || phoneNumber,
    userId: String(buyerId),
    subscriptionId: String(subscription._id),
    countryIso,
  });

  return {
    success: true,
    number: String(result.number || '').replace(/^\+/, ''),
    phoneNumberE164: companyNumber?.phoneNumber || result.phoneNumberE164 || phoneNumber,
    sid: result.providerSid || companyNumber?.twilioSid || '',
    message: result.message || 'Number purchased successfully.',
    retailMonthlyPrice: retail.monthlyPriceUsd,
    currency: retail.currency,
    companyPhoneNumberId: companyNumber ? String(companyNumber._id) : null,
    subscription: {
      id: String(subscription._id),
      status: subscription.status,
      paymentStatus: subscription.paymentStatus,
      billingInterval: subscription.billingInterval,
      retailMonthlyPrice: subscription.retailMonthlyPrice,
      currency: subscription.currency,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    },
  };
}

