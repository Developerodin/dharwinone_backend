import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHasPermission,
  sanitizeCallRecord,
  sanitizeCallRecords,
  TRANSCRIPT_FIELDS,
  AI_FIELDS,
} from '../callRecordAccess.util.js';

const fullRecord = () => ({
  _id: 'r1',
  status: 'completed',
  transcript: 't',
  conversationTranscript: [{ role: 'agent', text: 'hi' }],
  extractedData: { name: 'X' },
  verification: { verified: true },
  callQuality: { score: 9 },
  intelligence: { transcriptSid: 'GT0', summary: 'ai summary' },
  notes: 'keep me',
});

test('sanitizeCallRecord strips transcript fields without canViewTranscripts', () => {
  const out = sanitizeCallRecord(fullRecord(), { canViewTranscripts: false, canViewAi: true });
  for (const f of TRANSCRIPT_FIELDS) assert.equal(f in out, false, f);
  for (const f of AI_FIELDS) assert.equal(f in out, true, f);
  assert.equal(out.notes, 'keep me');
});

test('sanitizeCallRecord strips AI fields without canViewAi', () => {
  const out = sanitizeCallRecord(fullRecord(), { canViewTranscripts: true, canViewAi: false });
  for (const f of AI_FIELDS) assert.equal(f in out, false, f);
  for (const f of TRANSCRIPT_FIELDS) assert.equal(f in out, true, f);
});

test('sanitizeCallRecord default access strips both groups', () => {
  const out = sanitizeCallRecord(fullRecord());
  for (const f of [...TRANSCRIPT_FIELDS, ...AI_FIELDS]) assert.equal(f in out, false, f);
});

test('sanitizeCallRecord returns same object when both allowed, never mutates input', () => {
  const rec = fullRecord();
  const out = sanitizeCallRecord(rec, { canViewTranscripts: true, canViewAi: true });
  assert.equal(out, rec);
  const rec2 = fullRecord();
  sanitizeCallRecord(rec2, {});
  assert.equal(rec2.transcript, 't');
});

test('sanitizeCallRecord passes through null/undefined', () => {
  assert.equal(sanitizeCallRecord(null, {}), null);
  assert.equal(sanitizeCallRecord(undefined, {}), undefined);
});

test('sanitizeCallRecords maps arrays and passes through non-arrays', () => {
  const out = sanitizeCallRecords([fullRecord(), null], {});
  assert.equal(out.length, 2);
  assert.equal('transcript' in out[0], false);
  assert.equal(out[1], null);
  assert.equal(sanitizeCallRecords(undefined, {}), undefined);
});

test('authHasPermission: superuser bypass, alias resolution, missing context', () => {
  assert.equal(authHasPermission({ user: { platformSuperUser: true } }, 'call-ai.read'), true);
  assert.equal(authHasPermission({}, 'call-ai.read'), false);
  assert.equal(authHasPermission(null, 'call-ai.read'), false);
  const req = { authContext: { permissions: new Set(['communication.call-transcripts:view']) } };
  assert.equal(authHasPermission(req, 'call-transcripts.read'), true);
  assert.equal(authHasPermission(req, 'call-ai.read'), false);
});
