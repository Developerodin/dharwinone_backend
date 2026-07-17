import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Only the reporter, the assignee, or an admin may comment on a dev ticket —
 * everyone else with devTickets.view can read it but not comment.
 */
test('devTicket.service addComment access', async () => {
  let ticket = null;
  const resetTicket = () => {
    ticket = {
      createdBy: 'creator',
      assignedTo: 'assignee',
      comments: [],
      attachments: [],
      addComment: async function (content, by) {
        this.comments.push({ content, commentedBy: by });
      },
      logActivity: () => {},
      save: async function () { return this; },
      populate: async function () { return this; },
      toObject() { return { ...this }; },
    };
    return ticket;
  };

  test.mock.module('../../models/devTicket.model.js', {
    defaultExport: { findById: async () => ticket },
  });
  test.mock.module('../../config/s3.js', {
    namedExports: { generatePresignedDownloadUrl: async (k) => `https://signed/${k}` },
  });
  test.mock.module('../upload.service.js', { namedExports: { uploadMultipleFilesToS3: async () => [] } });
  test.mock.module('../notification.service.js', { namedExports: { notify: async () => {} } });
  test.mock.module('../../config/logger.js', { defaultExport: { warn: () => {}, info: () => {} } });
  test.mock.module('../../models/user.model.js', {
    defaultExport: {
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      findById: async () => null,
      findOne: () => ({ select: () => ({ lean: async () => null }) }),
    },
  });
  test.mock.module('../../utils/roleHelpers.js', {
    namedExports: { userIsAdmin: async (user) => Boolean(user?.isAdmin) },
  });

  const { addCommentToTicket } = await import('../devTicket.service.js');

  // Assignee — the reported bug: assigned user could not comment.
  resetTicket();
  await addCommentToTicket('t1', 'looking into it', { id: 'assignee' });
  assert.equal(ticket.comments.length, 1, 'assignee should be able to comment');

  // Reporter.
  resetTicket();
  await addCommentToTicket('t1', 'any update?', { id: 'creator' });
  assert.equal(ticket.comments.length, 1, 'reporter should be able to comment');

  // Admin on someone else's ticket.
  resetTicket();
  await addCommentToTicket('t1', 'triaged', { id: 'someone-else', isAdmin: true });
  assert.equal(ticket.comments.length, 1, 'admin should be able to comment');

  // Bystander with view access only.
  resetTicket();
  await assert.rejects(
    () => addCommentToTicket('t1', 'me too', { id: 'bystander' }),
    (err) => err.statusCode === 403,
    'bystander should be rejected with 403'
  );
  assert.equal(ticket.comments.length, 0, 'bystander comment must not persist');
});
