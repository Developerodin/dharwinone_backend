import { test } from 'node:test';
import assert from 'node:assert/strict';
import TranscriptSegment from '../transcriptSegment.model.js';

test('TranscriptSegment validation requires meetingId, sequenceNumber, windows, combinedText', () => {
  const seg = new TranscriptSegment({});
  const err = seg.validateSync();
  assert.ok(err);
  assert.ok(err.errors.meetingId);
  assert.ok(err.errors.sequenceNumber);
  assert.ok(err.errors.windowStartMs);
  assert.ok(err.errors.windowEndMs);
  assert.ok(err.errors.combinedText);
});

test('TranscriptSegment accepts a valid embedded utterance', () => {
  const seg = new TranscriptSegment({
    meetingId: 'meeting_abc',
    sequenceNumber: 0,
    windowStartMs: 0,
    windowEndMs: 30000,
    combinedText: 'hello world',
    utteranceCount: 1,
    utterances: [{
      speaker: 'user_42',
      speakerName: 'Alice',
      speakerSource: 'livekit',
      text: 'hello world',
      startMs: 100,
      endMs: 1200,
      confidence: 0.97,
    }],
  });
  assert.equal(seg.validateSync(), undefined);
});

test('TranscriptSegment rejects unknown speakerSource enum', () => {
  const seg = new TranscriptSegment({
    meetingId: 'meeting_abc',
    sequenceNumber: 0,
    windowStartMs: 0,
    windowEndMs: 30000,
    combinedText: 'x',
    utteranceCount: 1,
    utterances: [{ speakerSource: 'martian', text: 'x', startMs: 0, endMs: 1 }],
  });
  const err = seg.validateSync();
  assert.ok(err);
});
