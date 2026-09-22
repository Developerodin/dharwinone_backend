/**
 * Playlist content-type counts for module list cards.
 *
 * The list UI shows five numbers per module (videos / PDFs / blogs / quiz / essays).
 * It used to derive them in the browser from the full `playlist` array, which meant
 * shipping every playlist item of every module purely to count them — about 2MB and
 * ~19s of the module list's load time on a 215-module catalog. The counts are produced
 * here instead, and `playlist` stays out of list responses entirely.
 */

/** Six stored content types collapse into five display buckets; both video kinds share one. */
const BUCKET_BY_CONTENT_TYPE = {
  'upload-video': 'videos',
  'youtube-link': 'videos',
  'pdf-document': 'pdfs',
  blog: 'blogs',
  quiz: 'quiz',
  essay: 'essays',
};

/**
 * @returns {{ videos: number, pdfs: number, blogs: number, quiz: number, essays: number }}
 */
export function emptyPlaylistSummary() {
  return { videos: 0, pdfs: 0, blogs: 0, quiz: 0, essays: 0 };
}

/**
 * Fold `{ contentType, count }` rows from the aggregation into display buckets.
 * An unrecognised content type is skipped rather than thrown on: the enum can gain
 * a value before this map does, and a list card is not worth a 500.
 *
 * @param {{ contentType?: string, count?: number }[] | null | undefined} rows
 * @returns {ReturnType<typeof emptyPlaylistSummary>}
 */
export function foldPlaylistCounts(rows) {
  const summary = emptyPlaylistSummary();
  for (const row of rows ?? []) {
    const bucket = BUCKET_BY_CONTENT_TYPE[row?.contentType];
    if (bucket) summary[bucket] += row?.count ?? 0;
  }
  return summary;
}

/**
 * The same counts, from a playlist array already in memory. Kept in this file so the
 * two paths cannot drift: a module must not show different numbers on the list than
 * on its detail view.
 *
 * @param {{ contentType?: string }[] | null | undefined} playlist
 * @returns {ReturnType<typeof emptyPlaylistSummary>}
 */
export function summarizePlaylist(playlist) {
  const summary = emptyPlaylistSummary();
  for (const item of playlist ?? []) {
    const bucket = BUCKET_BY_CONTENT_TYPE[item?.contentType];
    if (bucket) summary[bucket] += 1;
  }
  return summary;
}
