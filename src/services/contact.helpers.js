import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

export function normalizePhones(phones) {
  if (!Array.isArray(phones) || phones.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one phone is required');
  }
  const out = phones.map((p) => ({
    label: p.label ?? 'mobile',
    number: String(p.number).trim(),
    normalizedNumber: String(p.number).replace(/\D/g, ''),
    isPrimary: Boolean(p.isPrimary),
  }));
  const flagged = out.findIndex((p) => p.isPrimary);
  const primaryIdx = flagged === -1 ? 0 : flagged;
  out.forEach((p, i) => { p.isPrimary = i === primaryIdx; });
  return out;
}

export function buildContactFilter({ tenantId, ownerId, q, favorite }) {
  const filter = { tenantId, ownerId, deletedAt: null };
  if (favorite === true) filter.favorite = true;
  const term = String(q ?? '').trim();
  if (term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = term.replace(/\D/g, '');
    filter.$or = [{ name: re }, { email: re }, { company: re }];
    // >=6 digits: a meaningful phone prefix. Shorter widens the index range for little value.
    if (digits.length >= 6) filter.$or.push({ 'phones.normalizedNumber': { $regex: `^${digits}` } });
  }
  return filter;
}

export function pickSuggestedLink({ employees = [], users = [] }) {
  const emp = employees[0];
  if (emp) return { type: emp.personType || 'employee', id: emp._id, name: emp.name };
  const usr = users[0];
  if (usr) return { type: 'user', id: usr._id, name: usr.name };
  return null;
}

export function assertOwner(contact, userId) {
  if (!contact) throw new ApiError(httpStatus.NOT_FOUND, 'Contact not found');
  if (String(contact.ownerId) !== String(userId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Not allowed');
  }
}
