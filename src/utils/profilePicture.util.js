import { generatePresignedDownloadUrl } from '../config/s3.js';

/** Presigned TTL for profile pictures (7 days — matches document presign on applicant lists). */
export const PROFILE_PICTURE_PRESIGN_TTL_SEC = 7 * 24 * 3600;

/**
 * Cache-Control returned on presigned profile-picture GETs (align max-age with presign TTL).
 * Bucket objects may still ship Cache-Control: max-age=0 until upload sets metadata;
 * this overrides on each signed read. For CloudFront, also set object or distribution cache policy.
 */
export const PROFILE_PICTURE_RESPONSE_CACHE_CONTROL = `public, max-age=${PROFILE_PICTURE_PRESIGN_TTL_SEC}, immutable`;

const PRESIGNED_S3_URL_RE = /X-Amz-(Algorithm|Credential|Date|Expires|Signature)/i;

/**
 * Parse S3 object key from a typical HTTPS object URL (virtual-hosted or path-style).
 * Returns null for localhost or non-S3 URLs.
 */
export function extractS3KeyFromObjectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (/localhost|127\.0\.0\.1/i.test(url)) return null;
  const pattern1 = /https?:\/\/[^/]+\.s3[.-][^/]+\.amazonaws\.com\/([^?]+)/;
  const match1 = url.match(pattern1);
  if (match1) return decodeURIComponent(match1[1]);
  const pattern2 = /https?:\/\/s3[.-][^/]+\.amazonaws\.com\/[^/]+\/([^?]+)/;
  const match2 = url.match(pattern2);
  if (match2) return decodeURIComponent(match2[1]);
  return null;
}

/** True when url looks like an AWS SigV4 presigned GET (not a stable public CDN URL). */
export function isPresignedS3ObjectUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return PRESIGNED_S3_URL_RE.test(url) && /\.amazonaws\.com\//i.test(url);
}

/**
 * Resolve the S3 key for a profile picture: prefer stored key, else derive from a prior presigned URL.
 */
export function resolveProfilePictureS3Key(profilePicture) {
  if (!profilePicture) return null;
  const explicit = String(profilePicture.key || '').trim();
  if (explicit) return explicit;
  const url = String(profilePicture.url || '').trim();
  if (!url) return null;
  return extractS3KeyFromObjectUrl(url);
}

/**
 * Refresh an assignee/user/candidate profile picture URL when stored as an S3 key (presigned URLs expire).
 * When only a stale presigned URL is stored, derives the key at read time and re-signs.
 */
export async function refreshProfilePictureInPlace(profilePicture, options = {}) {
  if (!profilePicture) return;

  const ttlSec = options.ttlSec ?? PROFILE_PICTURE_PRESIGN_TTL_SEC;
  const signDownloadUrl = options.signDownloadUrl ?? generatePresignedDownloadUrl;

  const key = resolveProfilePictureS3Key(profilePicture);
  if (!key) {
    if (isPresignedS3ObjectUrl(profilePicture.url)) {
      profilePicture.url = undefined;
    }
    return;
  }

  if (!profilePicture.key) {
    profilePicture.key = key;
  }

  try {
    profilePicture.url = await signDownloadUrl(key, ttlSec, {
      responseCacheControl: PROFILE_PICTURE_RESPONSE_CACHE_CONTROL,
    });
  } catch {
    if (isPresignedS3ObjectUrl(profilePicture.url)) {
      profilePicture.url = undefined;
    }
  }
}

/** Refresh profile pictures on employee list rows (GET /employees). */
export async function refreshEmployeeListProfilePictures(employees) {
  if (!Array.isArray(employees) || !employees.length) return;
  await Promise.all(
    employees.map(async (row) => {
      if (row?.profilePicture) {
        await refreshProfilePictureInPlace(row.profilePicture);
      }
    })
  );
}

/** Refresh profile pictures on populated candidate rows in job-application list payloads. */
export async function refreshApplicationCandidateProfilePictures(apps) {
  if (!Array.isArray(apps) || !apps.length) return;
  await Promise.all(
    apps.map(async (app) => {
      if (app?.candidate?.profilePicture) {
        await refreshProfilePictureInPlace(app.candidate.profilePicture);
      }
    })
  );
}

/** Refresh profile pictures on populated User assignee arrays (mutates in place). */
export async function refreshAssigneesProfilePicturesInPlace(assignees) {
  if (!Array.isArray(assignees)) return;
  await Promise.all(
    assignees.map(async (user) => {
      if (user?.profilePicture) {
        await refreshProfilePictureInPlace(user.profilePicture);
      }
    })
  );
}

/** Refresh assignee avatars on task documents returned from Mongoose queries. */
export async function refreshTasksAssigneesProfilePictures(tasks) {
  if (!Array.isArray(tasks)) return;
  await Promise.all(
    tasks.map(async (task) => {
      await refreshAssigneesProfilePicturesInPlace(task.assignedTo);
    })
  );
}
