/**
 * Playback presign TTL: browsers re-request ranges during playback.
 * ponytail: fixed 3600s minimum; scale with duration for long recordings.
 */
export const recordingPlaybackExpiresSeconds = (durationMs) => {
  const minSeconds = 3600;
  const d = Number(durationMs);
  if (!Number.isFinite(d) || d <= 0) return minSeconds;
  return Math.max(minSeconds, Math.ceil(d / 1000) + 600);
};
