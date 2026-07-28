/**
 * Monthly number subscriptions created on (payment-skipped) Buy Number.
 */

import httpStatus from 'http-status';
import NumberSubscription from '../models/numberSubscription.model.js';
import ApiError from '../utils/ApiError.js';

function addOneMonth(from = new Date()) {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Create an active monthly subscription (payment waived until Stripe is wired).
 */
export async function createWaivedSubscription({
  tenantId,
  userId,
  companyPhoneNumberId,
  phoneNumber,
  twilioSid,
  retailMonthlyPrice,
  currency = 'USD',
}) {
  const now = new Date();
  const doc = await NumberSubscription.create({
    tenantId,
    userId,
    companyPhoneNumberId: companyPhoneNumberId || null,
    phoneNumber,
    twilioSid: twilioSid || '',
    status: 'active',
    billingInterval: 'month',
    retailMonthlyPrice: Number(retailMonthlyPrice),
    currency,
    paymentStatus: 'waived',
    currentPeriodStart: now,
    currentPeriodEnd: addOneMonth(now),
  });
  return doc;
}

/** List subscriptions for the authenticated buyer. */
export async function listSubscriptionsForUser(userId, { page = 1, limit = 50, status } = {}) {
  const filter = { userId };
  if (status) filter.status = status;
  return NumberSubscription.paginate(filter, {
    page: Number(page) || 1,
    limit: Math.min(Number(limit) || 50, 100),
    sortBy: 'createdAt:desc',
  });
}

/** Map of companyPhoneNumberId → subscription lean doc for enrichment. */
export async function mapSubscriptionsByCompanyPhoneNumberIds(ids = []) {
  const objectIds = (ids || []).filter(Boolean);
  if (!objectIds.length) return new Map();
  const rows = await NumberSubscription.find({
    companyPhoneNumberId: { $in: objectIds },
  }).lean();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.companyPhoneNumberId), row);
  }
  return map;
}

export async function getActiveSubscriptionForPhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  return NumberSubscription.findOne({
    phoneNumber,
    status: 'active',
  }).lean();
}

export async function cancelSubscription(subscriptionId, userId, { isAdmin = false } = {}) {
  const filter = isAdmin ? { _id: subscriptionId } : { _id: subscriptionId, userId };
  const doc = await NumberSubscription.findOne(filter);
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Subscription not found');
  if (doc.status === 'canceled') return doc;
  doc.status = 'canceled';
  doc.canceledAt = new Date();
  await doc.save();
  return doc;
}

export default {
  createWaivedSubscription,
  listSubscriptionsForUser,
  mapSubscriptionsByCompanyPhoneNumberIds,
  getActiveSubscriptionForPhoneNumber,
  cancelSubscription,
};
