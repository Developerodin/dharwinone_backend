/** Presigned TTL for training module cover images (7 days). */
export const TRAINING_COVER_IMAGE_PRESIGN_TTL_SEC = 7 * 24 * 3600;

/**
 * Regenerate a fresh presigned download URL when the cover image is stored in S3.
 * Mutates `coverImage.url` in place (matches trainingModule.service.js behavior).
 *
 * @param {{ key?: string, url?: string } | null | undefined} coverImage
 * @param {(key: string, ttlSec: number) => Promise<string>} signDownloadUrl
 * @param {number} [ttlSec]
 * @returns {Promise<void>}
 */
export const refreshTrainingCoverImageUrl = async (
  coverImage,
  signDownloadUrl,
  ttlSec = TRAINING_COVER_IMAGE_PRESIGN_TTL_SEC
) => {
  if (!coverImage?.key) return;
  coverImage.url = await signDownloadUrl(coverImage.key, ttlSec);
};

/**
 * Default cap on parallel signs. Signing is local crypto, so an unbounded Promise.all
 * over a whole catalog occupies the event loop in a single burst.
 */
export const TRAINING_COVER_PRESIGN_CONCURRENCY = 25;

/**
 * Refresh cover image URLs for many modules, a bounded number at a time.
 *
 * @param {Array<{ coverImage?: { key?: string, url?: string } }>} modules
 * @param {(key: string, ttlSec: number) => Promise<string>} signDownloadUrl
 * @param {(error: unknown) => void} [onError]
 * @param {number} [concurrency]
 */
export const refreshTrainingModuleCoverImages = async (
  modules,
  signDownloadUrl,
  onError,
  concurrency = TRAINING_COVER_PRESIGN_CONCURRENCY
) => {
  if (!modules?.length) return;
  const targets = modules.filter((module) => module?.coverImage?.key);
  if (!targets.length) return;

  const limit = Math.max(1, concurrency);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    while (next < targets.length) {
      const { coverImage } = targets[next];
      next += 1;
      try {
        await refreshTrainingCoverImageUrl(coverImage, signDownloadUrl);
      } catch (error) {
        if (onError) onError(error);
      }
    }
  });
  await Promise.all(runners);
};
