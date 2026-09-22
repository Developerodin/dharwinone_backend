import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPlaylistSummary,
  foldPlaylistCounts,
  summarizePlaylist,
} from '../playlistSummary.util.js';

test('emptyPlaylistSummary: every bucket starts at zero', () => {
  assert.deepEqual(emptyPlaylistSummary(), {
    videos: 0,
    pdfs: 0,
    blogs: 0,
    quiz: 0,
    essays: 0,
  });
});

test('emptyPlaylistSummary: returns a fresh object each call', () => {
  const a = emptyPlaylistSummary();
  a.videos = 99;
  assert.equal(emptyPlaylistSummary().videos, 0);
});

test('foldPlaylistCounts: both video content types land in one videos bucket', () => {
  const s = foldPlaylistCounts([
    { contentType: 'upload-video', count: 3 },
    { contentType: 'youtube-link', count: 4 },
  ]);
  assert.equal(s.videos, 7);
});

test('foldPlaylistCounts: each remaining content type maps to its own bucket', () => {
  const s = foldPlaylistCounts([
    { contentType: 'pdf-document', count: 2 },
    { contentType: 'blog', count: 5 },
    { contentType: 'quiz', count: 1 },
    { contentType: 'essay', count: 6 },
  ]);
  assert.deepEqual(s, { videos: 0, pdfs: 2, blogs: 5, quiz: 1, essays: 6 });
});

test('foldPlaylistCounts: an unknown content type is ignored, not thrown on', () => {
  const s = foldPlaylistCounts([
    { contentType: 'hologram', count: 9 },
    { contentType: 'quiz', count: 1 },
  ]);
  assert.deepEqual(s, { videos: 0, pdfs: 0, blogs: 0, quiz: 1, essays: 0 });
});

test('foldPlaylistCounts: empty, null and undefined input all give zeros', () => {
  for (const input of [[], null, undefined]) {
    assert.deepEqual(foldPlaylistCounts(input), emptyPlaylistSummary());
  }
});

test('foldPlaylistCounts: a missing count is treated as zero', () => {
  const s = foldPlaylistCounts([{ contentType: 'quiz' }]);
  assert.equal(s.quiz, 0);
});

// summarizePlaylist is the in-memory equivalent, used where the playlist is
// already loaded. It must agree with the aggregation fold exactly, or a module
// would show different counts on the list than on the detail view.
test('summarizePlaylist: counts a raw playlist array the same way', () => {
  const playlist = [
    { contentType: 'upload-video' },
    { contentType: 'youtube-link' },
    { contentType: 'pdf-document' },
    { contentType: 'blog' },
    { contentType: 'blog' },
    { contentType: 'quiz' },
    { contentType: 'essay' },
    { contentType: 'essay' },
    { contentType: 'essay' },
  ];
  assert.deepEqual(summarizePlaylist(playlist), {
    videos: 2,
    pdfs: 1,
    blogs: 2,
    quiz: 1,
    essays: 3,
  });
});

test('summarizePlaylist: empty and missing playlists give zeros', () => {
  for (const input of [[], null, undefined]) {
    assert.deepEqual(summarizePlaylist(input), emptyPlaylistSummary());
  }
});

test('summarizePlaylist and foldPlaylistCounts agree on the same data', () => {
  const playlist = [
    { contentType: 'upload-video' },
    { contentType: 'upload-video' },
    { contentType: 'youtube-link' },
    { contentType: 'quiz' },
  ];
  const folded = foldPlaylistCounts([
    { contentType: 'upload-video', count: 2 },
    { contentType: 'youtube-link', count: 1 },
    { contentType: 'quiz', count: 1 },
  ]);
  assert.deepEqual(summarizePlaylist(playlist), folded);
});
