import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveUtteranceTimebase,
  offsetFromBase,
  mapV2Utterances,
  buildV2Segment,
} from '../agentInternalV2.helpers.js';

const EPOCH = 1758000000000;

const raw = (over = {}) => ({
  utteranceId: 'u-1',
  participantIdentity: 'guest-abc',
  displayName: 'Dave',
  text: 'hello',
  startedAtEpochMs: EPOCH,
  endedAtEpochMs: EPOCH + 1500,
  confidence: 0.9,
  ...over,
});

test('timebase prefers the egress file start over the egress start', () => {
  const r = resolveUtteranceTimebase([raw()], {
    egressFileStartedAtEpochMs: EPOCH - 5000,
    egressStartedAtEpochMs: EPOCH - 9000,
  });
  assert.equal(r.timebase, 'egress');
  assert.equal(r.baseMs, EPOCH - 5000);
});

test('timebase falls back to the egress start', () => {
  const r = resolveUtteranceTimebase([raw()], { egressStartedAtEpochMs: EPOCH - 9000 });
  assert.equal(r.timebase, 'egress');
  assert.equal(r.baseMs, EPOCH - 9000);
});

test('timebase falls back to the earliest utterance when no egress epoch was recorded', () => {
  const r = resolveUtteranceTimebase(
    [raw({ startedAtEpochMs: EPOCH + 7000 }), raw({ startedAtEpochMs: EPOCH })],
    { egressFileStartedAtEpochMs: null, egressStartedAtEpochMs: null }
  );
  assert.equal(r.timebase, 'first_utterance');
  assert.equal(r.baseMs, EPOCH);
});

test('timebase is none for an empty transcript', () => {
  assert.deepEqual(resolveUtteranceTimebase([], {}), { baseMs: null, timebase: 'none' });
});

test('offsetFromBase returns null before the base and null when unanchored', () => {
  assert.equal(offsetFromBase(EPOCH - 1, EPOCH), null);
  assert.equal(offsetFromBase(EPOCH, null), null);
  assert.equal(offsetFromBase('nope', EPOCH), null);
  assert.equal(offsetFromBase(EPOCH + 2000, EPOCH), 2000);
});

test('mapV2Utterances derives startMs/endMs from epochs when recordingOffsetMs is absent', () => {
  const { utterances, timebase } = mapV2Utterances(
    [raw(), raw({ utteranceId: 'u-2', startedAtEpochMs: EPOCH + 4000, endedAtEpochMs: EPOCH + 6000 })],
    { egressFileStartedAtEpochMs: null, egressStartedAtEpochMs: null }
  );
  assert.equal(timebase, 'first_utterance');
  assert.equal(utterances[0].startMs, 0);
  assert.equal(utterances[0].endMs, 1500);
  assert.equal(utterances[1].startMs, 4000);
  assert.equal(utterances[1].endMs, 6000);
});

test('mapV2Utterances never leaks a raw epoch into startMs', () => {
  const { utterances } = mapV2Utterances([raw()], null);
  assert.ok(utterances[0].startMs < 24 * 60 * 60 * 1000, 'startMs must be an offset, not an epoch');
});

test('mapV2Utterances keeps an assembled recordingOffsetMs', () => {
  const { utterances } = mapV2Utterances([raw({ recordingOffsetMs: 12000 })], {
    egressFileStartedAtEpochMs: EPOCH - 12000,
  });
  assert.equal(utterances[0].startMs, 12000);
  assert.equal(utterances[0].endMs, 13500);
});

test('mapV2Utterances carries speaker identity through unchanged', () => {
  const { utterances } = mapV2Utterances([raw()], null);
  assert.equal(utterances[0].speaker, 'guest-abc');
  assert.equal(utterances[0].speakerName, 'Dave');
});

test('buildV2Segment ends at the latest utterance end, not the last start', () => {
  const { utterances } = mapV2Utterances(
    [
      raw({ startedAtEpochMs: EPOCH, endedAtEpochMs: EPOCH + 30000 }),
      raw({ utteranceId: 'u-2', startedAtEpochMs: EPOCH + 5000, endedAtEpochMs: EPOCH + 9000 }),
    ],
    null
  );
  const seg = buildV2Segment(utterances);
  assert.equal(seg.windowStartMs, 0);
  assert.equal(seg.windowEndMs, 30000);
  assert.equal(seg.utterances[0].endMs, 30000, 'endMs must survive');
});

test('buildV2Segment returns null for no utterances', () => {
  assert.equal(buildV2Segment([]), null);
});
