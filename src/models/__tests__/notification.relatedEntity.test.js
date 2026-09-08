import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Notification from '../notification.model.js';

/**
 * Meeting notifications reference a meeting by its LiveKit room id (`meeting_<hex>`),
 * not by its ObjectId — both route resolvers build `/join/room?room=<id>` from it.
 * The schema path must therefore accept a plain string. No database needed:
 * validateSync runs the same casting the real write does.
 */
const build = (id) =>
  new Notification({
    user: new mongoose.Types.ObjectId(),
    type: 'meeting_reminder',
    title: 'Interview reminder',
    message: 'Your interview starts soon.',
    link: '/join/room?room=meeting_0a33c0436e6c302d',
    relatedEntity: { type: 'meeting', id },
  });

test('a meeting room id is a valid relatedEntity.id', () => {
  const err = build('meeting_0a33c0436e6c302d').validateSync();
  assert.equal(err, undefined);
});

test('an ObjectId-shaped id is still accepted and reads back as its hex string', () => {
  const oid = new mongoose.Types.ObjectId();
  const doc = build(oid);
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.relatedEntity.id, oid.toString());
});

test('a null id is still allowed', () => {
  assert.equal(build(null).validateSync(), undefined);
});
