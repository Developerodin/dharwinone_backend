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

/**
 * SINGLE-COMPANY ARCHITECTURE.
 *
 * CompanyPhoneNumber is the company's ONE shared registry — it is deliberately NOT
 * partitioned by tenant. This app has no organization entity: `user.tenantId` is null for
 * every user and `user.adminId` is a creator pointer (whoever was logged in when the
 * account was made), so deriving a tenant from the operator split one company's registry
 * into a partition per operator — each admin saw a different set of numbers, and Sync
 * created a second local row for a Twilio number that already existed under someone else.
 *
 * Who may READ or MANAGE the registry is still controlled by RBAC
 * (company-number.read / company-number.manage) on the routes. Global !== unguarded.
 *
 * @see provenanceTenantId — stamped on new rows for audit only, never a query filter.
 */

/**
 * Provenance stamp for NEW rows only: which operator's account created this record.
 * The column is retained for audit/history and to satisfy the schema's `required`.
 *
 * NEVER use this in a query filter for CompanyPhoneNumber — doing so re-creates the
 * per-operator partition this module was fixed to remove.
 */
function provenanceTenantId(user) {
  return user?.tenantId || user?.adminId || user?._id || user?.id;
}

const ALREADY_ASSIGNED_MESSAGE = 'This number is already assigned to another user.';

/** One user -> at most one number, company-wide. */
async function clearUserAssignments(userId, exceptId = null) {
  const filter = { assignedTo: userId };
  if (exceptId) filter._id = { $ne: exceptId };
  await CompanyPhoneNumber.updateMany(filter, { $set: { assignedTo: null } });
}

/**
 * The single place both assign-user and PATCH apply the assignment invariants:
 *   one number -> one user   claim is ONE atomic findOneAndUpdate, so two concurrent
 *                            claims cannot both win; stealing requires allowReassign
 *   one user -> one number   the user's other numbers are cleared afterwards
 *
 * Claim first, clear second: the old order cleared the user's numbers and only then
 * looked the target up, so a 404 left the user holding nothing.
 *
 * @param {{ companyPhoneNumberId: any, userId: any, allowReassign?: boolean }} params
 *   allowReassign — the admin assign-user flow may move a number between users. PATCH may not.
 */
async function claimNumberForUser({ companyPhoneNumberId, userId, allowReassign = false }) {
  const filter = { _id: companyPhoneNumberId };
  if (!allowReassign) {
    filter.$or = [{ assignedTo: null }, { assignedTo: userId }];
  }

  const claimed = await CompanyPhoneNumber.findOneAndUpdate(
    filter,
    { $set: { assignedTo: userId } },
    { new: true },
  );

  if (!claimed) {
    const exists = await CompanyPhoneNumber.exists({ _id: companyPhoneNumberId });
    throw exists
      ? new ApiError(httpStatus.CONFLICT, ALREADY_ASSIGNED_MESSAGE)
      : new ApiError(httpStatus.NOT_FOUND, 'Company phone number not found');
  }

  await clearUserAssignments(userId, claimed._id);
  return claimed;
}

function currentTelephonyProvider() {
  return config.telephony?.provider === 'twilio' ? 'twilio' : 'plivo';
}

/** Dropdown registry query: active-provider numbers + any assigned row (cross-provider visibility). */
export function buildAssignableNumbersQuery(activeProvider) {
  const providerClauses =
    activeProvider === 'twilio'
      ? [{ provider: 'twilio' }, { provider: { $exists: false } }, { provider: null }]
      : [{ provider: activeProvider }];

  return {
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
      // One company, one registry: an active E.164 resolves to a single canonical row, so
      // no tenant context is needed (and the public webhook has none to give). The prior
      // multi-row disambiguation existed only because the per-operator partition let one
      // Twilio number exist twice; the provider-identity dedup removes that possibility.
      const mappings = await CompanyPhoneNumber.find({ phoneNumber: phone, isActive: true })
        .select('assignedTo')
        .sort({ createdAt: 1 })
        .lean();

      if (mappings.length > 1) {
        logger.warn('[CompanyPhoneNumber] duplicate active rows for one number — run the dedup migration', {
          phone,
          rows: mappings.length,
        });
      }

      const mapping = mappings.find((m) => m.assignedTo) || mappings[0];
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

/**
 * Resolve outbound dialer ownership from an assigned company work number (caller ID).
 * PSTN child-leg webhooks only carry phone numbers in From/To — not client:user_<id>.
 * @param {string} callerId
 * @returns {Promise<string>} Mongo User id or ''
 */
export async function resolveUserIdForAssignedCallerId(callerId) {
  const phone = normalizeCalledNumber(callerId);
  if (!phone) return '';

  if (mongoose.connection.readyState === 1) {
    try {
      const row = await CompanyPhoneNumber.findOne({
        phoneNumber: phone,
        isActive: true,
        assignedTo: { $ne: null },
      })
        .select('assignedTo')
        .lean();
      if (row?.assignedTo) return String(row.assignedTo);
    } catch (err) {
      logger.warn('[CompanyPhoneNumber] outbound caller-id lookup failed', { phone, err: err?.message });
    }
  }

  return '';
}

export async function listCompanyPhoneNumbers(_user, filters = {}) {
  // Company-global: every operator with company-number.read sees the same registry.
  const query = {};

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

/**
 * Canonical identity of a provider-owned number: the provider resource, NOT the phone
 * string and NOT the operator. One Twilio SID == one local row, so it does not matter
 * who presses Sync. Falls back to provider + normalized E.164 only when the provider
 * gave us no SID.
 */
async function findByProviderIdentity({ provider, twilioSid, phoneNumber }) {
  if (twilioSid) {
    const bySid = await CompanyPhoneNumber.findOne({ provider, twilioSid });
    if (bySid) return bySid;
    // Legacy rows synced before SIDs were stored: adopt by number, then backfill the SID.
    const legacy = await CompanyPhoneNumber.findOne({ provider, phoneNumber, twilioSid: { $in: ['', null] } });
    if (legacy) return legacy;
  }
  return CompanyPhoneNumber.findOne({ provider, phoneNumber });
}

export async function syncCompanyPhoneNumbersFromProvider(user) {
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

    // Keyed on the provider resource, so Sync run by ANY operator updates the same row
    // instead of creating a second copy under that operator's old tenant partition.
    const existing = await findByProviderIdentity({
      provider: mapped.provider,
      twilioSid: mapped.twilioSid,
      phoneNumber: mapped.phoneNumber,
    });

    if (!existing) {
      await CompanyPhoneNumber.create({
        tenantId: provenanceTenantId(user),
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
      // Provider metadata only. `assignedTo` is deliberately absent here: a sync must never
      // assign, unassign or reassign a number — only an explicit assignment operation may.
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
  const telephonyService = (await import('./telephony.service.js')).default;
  const provider = telephonyService.getProviderName();
  const phoneNumber = normalizeCalledNumber(
    purchasePayload.phoneNumberE164 || purchasePayload.number || purchasePayload.phoneNumber,
  );
  if (!phoneNumber) return null;

  const buyerId = user._id || user.id;
  const payload = {
    tenantId: provenanceTenantId(user),
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

  const existing = await findByProviderIdentity({ provider, twilioSid: payload.twilioSid, phoneNumber });
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }

  return CompanyPhoneNumber.create(payload);
}

export async function updateCompanyPhoneNumberById(_user, id, patch) {
  const doc = await CompanyPhoneNumber.findOne({ _id: id });
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Company phone number not found');

  if (patch.friendlyName !== undefined) doc.friendlyName = String(patch.friendlyName || '').trim();

  if (patch.isActive !== undefined) doc.isActive = Boolean(patch.isActive);

  if (patch.assignedTo !== undefined) {
    if (patch.assignedTo === null || patch.assignedTo === '') {
      doc.assignedTo = null;
    } else {
      const assignee = await User.findById(patch.assignedTo).select('_id');
      if (!assignee) throw new ApiError(httpStatus.BAD_REQUEST, 'Assigned user not found');
      // Same invariants as assign-user. allowReassign stays false so PATCH cannot take a
      // number off another user — deliberate reassignment goes through POST /assign-user.
      const claimed = await claimNumberForUser({
        companyPhoneNumberId: doc._id,
        userId: assignee._id,
        allowReassign: false,
      });
      doc.assignedTo = claimed.assignedTo;
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

/**
 * May authenticated user `userId` originate human dialer calls from `callerId`?
 *
 * Fail-closed: the number must be an active CompanyPhoneNumber row assigned to this
 * user. Provider account ownership is NOT authorization — every user's number sits on
 * the same Twilio/Plivo account. Unassigned, unregistered, and other users' numbers
 * are all rejected.
 *
 * Deliberately tenant-free: runs inside provider webhooks (no tenant context) and
 * `assignedTo` is already user-specific. AI-agent and in-app call paths do not use
 * this gate.
 */
export async function isCallerIdAllowedForUser(userId, callerId) {
  if (!userId) return false;
  const phone = normalizeCalledNumber(callerId);
  if (!phone) return false;
  // Match the assignment in the query rather than fetching one row and comparing it.
  // Fetch-then-compare reads an arbitrary row when a number has duplicate active rows
  // (the pre-dedup state migrateCompanyPhoneRegistryGlobal removes), so it could land on
  // the unassigned copy and refuse a user who IS correctly assigned.
  return Boolean(await CompanyPhoneNumber.exists({ phoneNumber: phone, isActive: true, assignedTo: userId }));
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

  // Company-global: the roster shows the same assignments to every authorized manager.
  const assignedRows = await CompanyPhoneNumber.find({ assignedTo: { $ne: null } })
    .select('phoneNumber friendlyName assignedTo isActive')
    .lean();
  const assignedByUserId = new Map();
  for (const row of assignedRows) {
    const uid = String(row.assignedTo);
    if (!assignedByUserId.has(uid)) assignedByUserId.set(uid, row);
  }

  const activeProvider = currentTelephonyProvider();
  const numbers = await CompanyPhoneNumber.find(buildAssignableNumbersQuery(activeProvider))
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
  // `_id: userId` MUST come after the spread. buildAssignableUsersQuery() sets its own `_id`
  // (the hidden-directory $nin), and the old `{ _id: userId, ...query }` order let that
  // clobber the id — findOne then returned an ARBITRARY assignable user and the number was
  // assigned to them instead of the one the operator picked. The hidden-user restriction is
  // preserved separately via $and so it still cannot be bypassed.
  const assignable = await buildAssignableUsersQuery(adminUser);
  const hiddenClause = assignable._id;
  const filter = { ...assignable, _id: userId };
  if (hiddenClause) filter.$and = [{ _id: hiddenClause }];

  const user = await User.findOne(filter).select('_id');
  if (!user) throw new ApiError(httpStatus.BAD_REQUEST, 'User not found');

  // Unassign: "— None —" in the roster clears whatever the user held, company-wide.
  if (!companyPhoneNumberId) {
    await clearUserAssignments(userId);
    return { userId: String(userId), companyPhoneNumberId: null, companyPhoneNumber: '' };
  }

  // allowReassign: this IS the intended admin reassignment flow (company-number.manage),
  // so moving a number from one user to another is deliberate here — unlike PATCH.
  const doc = await claimNumberForUser({
    companyPhoneNumberId,
    userId: user._id,
    allowReassign: true,
  });

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
    // NumberSubscription keeps its own tenant column — a different model, unchanged here.
    tenantId: provenanceTenantId(user),
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

