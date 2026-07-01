import test from 'node:test';
import assert from 'node:assert/strict';

test('createContact sets owner/tenant, normalizes, suggests when asked', async () => {
  const created = [];
  test.mock.module('../../models/contact.model.js', {
    defaultExport: {
      create: async (doc) => { created.push(doc); return { ...doc, _id: 'c1' }; },
      paginate: async (filter) => ({ results: [], filter }),
      findOne: async () => null,
    },
  });
  test.mock.module('../../models/employee.model.js', {
    defaultExport: { find: () => ({ select: () => ({ limit: () => ({ lean: async () => [{ _id: 'e1', name: 'Anita' }] }) }) }) },
  });
  test.mock.module('../../models/user.model.js', {
    defaultExport: { find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }) },
  });

  const { createContact } = await import('../contact.service.js');
  const user = { id: 'u1', _id: 'u1', tenantId: 't1' };
  const res = await createContact(user, {
    name: 'Anita', phones: [{ number: '+91 98765 43210' }], autoSuggestLink: true,
  });
  assert.equal(created[0].ownerId, 'u1');
  assert.equal(created[0].tenantId, 't1');
  assert.equal(created[0].phones[0].normalizedNumber, '919876543210');
  assert.deepEqual(res.suggestedLink, { type: 'employee', id: 'e1', name: 'Anita' });
});
