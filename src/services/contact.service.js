import Contact from '../models/contact.model.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import { normalizePhones, buildContactFilter, pickSuggestedLink, assertOwner } from './contact.helpers.js';

function tenantIdForUser(user) {
  return user?.tenantId || user?._id || user?.id;
}
function uid(user) {
  return user?._id || user?.id;
}

// Match candidate/employee (employee collection) + user by normalized number.
// Employee/User store phoneNumber unnormalized, so match on trailing digits.
async function matchPeopleByNumber(tenantId, normalized) {
  if (!normalized || normalized.length < 4) return { employees: [], users: [] };
  const re = new RegExp(`${normalized}$`);
  const [employees, users] = await Promise.all([
    Employee.find({ tenantId, phoneNumber: re }).select('name phoneNumber').limit(1).lean(),
    User.find({ tenantId, phoneNumber: re }).select('name phoneNumber').limit(1).lean(),
  ]);
  return { employees, users };
}

export async function createContact(user, body) {
  const tenantId = tenantIdForUser(user);
  const phones = normalizePhones(body.phones);
  const doc = await Contact.create({ ...body, phones, tenantId, ownerId: uid(user) });
  let suggestedLink = null;
  if (body.autoSuggestLink) {
    const primary = phones.find((p) => p.isPrimary) || phones[0];
    suggestedLink = pickSuggestedLink(await matchPeopleByNumber(tenantId, primary.normalizedNumber));
  }
  return { contact: doc, suggestedLink };
}

export async function queryContacts(user, query) {
  const filter = buildContactFilter({
    tenantId: tenantIdForUser(user), ownerId: uid(user), q: query.q, favorite: query.favorite,
  });
  const options = { sortBy: query.sortBy || 'updatedAt:desc', limit: query.limit || 25, page: query.page || 1 };
  return Contact.paginate(filter, options);
}

export async function getContactById(user, id) {
  const contact = await Contact.findOne({ _id: id, deletedAt: null });
  assertOwner(contact, uid(user));
  return contact;
}

export async function updateContact(user, id, patch) {
  const contact = await getContactById(user, id);
  const next = { ...patch };
  if (patch.phones) next.phones = normalizePhones(patch.phones);
  Object.assign(contact, next);
  await contact.save();
  return contact;
}

export async function softDeleteContact(user, id) {
  const contact = await getContactById(user, id);
  contact.deletedAt = new Date();
  await contact.save();
  return contact;
}
