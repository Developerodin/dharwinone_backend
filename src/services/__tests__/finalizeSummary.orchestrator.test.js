import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptJson } from '../summaryFinalize.service.js';

test('buildTranscriptJson flattens segments to ordered utterance array', () => {
  const segs = [
    {
      meetingId: 'm', sequenceNumber: 0, windowStartMs: 0, windowEndMs: 30000,
      combinedText: 'hi how are you', utteranceCount: 2,
      utterances: [
        { text: 'hi', startMs: 100, endMs: 500, speaker: 'a' },
        { text: 'how are you', startMs: 600, endMs: 1200, speaker: 'b' },
      ],
    },
    {
      meetingId: 'm', sequenceNumber: 1, windowStartMs: 30000, windowEndMs: 60000,
      combinedText: 'fine thanks', utteranceCount: 1,
      utterances: [
        { text: 'fine thanks', startMs: 31000, endMs: 32000, speaker: 'a' },
      ],
    },
  ];
  const j = buildTranscriptJson('m', segs, 60000);
  assert.equal(j.meetingId, 'm');
  assert.equal(j.durationMs, 60000);
  assert.equal(j.utterances.length, 3);
  assert.equal(j.utterances[0].text, 'hi');
  assert.equal(j.utterances[2].text, 'fine thanks');
});
