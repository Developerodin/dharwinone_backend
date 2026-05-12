import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUtterancesIntoWindows } from '../summaryFinalize.service.js';

test('splitUtterancesIntoWindows returns single window when small', () => {
  const u = [{ text: 'hello world', speaker: 'a', startMs: 0, endMs: 1000 }];
  const w = splitUtterancesIntoWindows(u, 1000);
  assert.equal(w.length, 1);
});

test('splitUtterancesIntoWindows breaks on speaker change near limit', () => {
  const filler = 'x'.repeat(4000);
  const u = [
    { text: filler, speaker: 'a', startMs: 0, endMs: 1 },
    { text: filler, speaker: 'b', startMs: 2, endMs: 3 },
    { text: filler, speaker: 'b', startMs: 4, endMs: 5 },
  ];
  const w = splitUtterancesIntoWindows(u, 1500);
  assert.equal(w.length, 2);
  assert.equal(w[0][0].speaker, 'a');
  assert.equal(w[1][0].speaker, 'b');
});

test('splitUtterancesIntoWindows never returns empty windows', () => {
  const w = splitUtterancesIntoWindows([], 100);
  assert.equal(w.length, 0);
});
