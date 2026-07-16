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
 * Refresh cover image URLs for many modules in parallel.
 *
 * @param {Array<{ coverImage?: { key?: string, url?: string } }>} modules
 * @param {(key: string, ttlSec: number) => Promise<string>} signDownloadUrl
 * @param {(error: unknown) => void} [onError]
 */
export const refreshTrainingModuleCoverImages = async (modules, signDownloadUrl, onError) => {
  if (!modules?.length) return;
  await Promise.all(
    modules.map(async (module) => {
      if (!module?.coverImage?.key) return;
      try {
        await refreshTrainingCoverImageUrl(module.coverImage, signDownloadUrl);
      } catch (error) {
        if (onError) onError(error);
      }
    })
  );
};
