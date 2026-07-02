/**
 * Classify a share-candidate-form invite registration attempt against an existing user lookup.
 *
 * - 'new'      — no user with this email; create User + Candidate profile.
 * - 'resume'   — an unfinished signup (pending, unverified) exists; update details and
 *                re-send the verification email instead of dead-ending at "account exists".
 * - 'conflict' — a verified and/or activated account exists; the only true "please log in" case.
 *
 * @param {{ status?: string, isEmailVerified?: boolean } | null | undefined} existingUser
 * @returns {'new'|'resume'|'conflict'}
 */
export const classifyInviteRegistration = (existingUser) => {
  if (!existingUser) return 'new';
  if (existingUser.isEmailVerified || existingUser.status !== 'pending') return 'conflict';
  return 'resume';
};
