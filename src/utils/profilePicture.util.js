import { generatePresignedDownloadUrl } from '../config/s3.js';

/** Refresh an assignee/user profile picture URL when stored as an S3 key (presigned URLs expire). */
export async function refreshProfilePictureInPlace(profilePicture) {
  if (!profilePicture?.key) return;
  try {
    profilePicture.url = await generatePresignedDownloadUrl(profilePicture.key, 7 * 24 * 3600);
  } catch {
    /* keep existing url if regeneration fails */
  }
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
