import logger from '../config/logger.js';
import { attachVersionedSlotUploadToCandidate } from './employee.service.js';

/**
 * Apply optional resume upload + AI-prefill profile arrays from public candidate registration.
 * Mirrors public job apply document handling (resume CV/Resume row + skills/experiences merge).
 */
export async function applyPublicCandidateRegistrationProfile(candidate, user, body, files) {
  if (!candidate) return candidate;

  const entryMode = String(body.entryMode || 'manual').toLowerCase() === 'ai' ? 'ai' : 'manual';

  const {
    normalizePublicApplySkills,
    normalizePublicApplyExperiences,
    normalizePublicApplyQualifications,
    normalizePublicApplySocialLinks,
    mergePublicApplyExperiences,
    mergePublicApplyQualifications,
    mergePublicApplySocialLinks,
    extractSkillsFromResumeBuffer,
  } = await import('./resumeSkillsExtract.service.js');

  let resumeSkills = [];
  let resumeExperiences = [];
  let resumeQualifications = [];
  let resumeSocialLinks = [];

  if (body.skills && String(body.skills).trim()) {
    resumeSkills = normalizePublicApplySkills(body.skills);
  }
  if (body.experiences && String(body.experiences).trim()) {
    resumeExperiences = normalizePublicApplyExperiences(body.experiences);
  }
  if (body.qualifications && String(body.qualifications).trim()) {
    resumeQualifications = normalizePublicApplyQualifications(body.qualifications);
  }
  if (body.socialLinks && String(body.socialLinks).trim()) {
    resumeSocialLinks = normalizePublicApplySocialLinks(body.socialLinks);
  }

  if (files?.resume?.[0]) {
    const { uploadFileToS3 } = await import('./upload.service.js');
    const resumeFile = files.resume[0];
    const r = await uploadFileToS3(resumeFile, user._id, 'candidate-resumes');
    await attachVersionedSlotUploadToCandidate(
      candidate,
      'resume',
      {
        url: r.url,
        key: r.key,
        originalName: r.originalName,
        size: r.size,
        mimeType: r.mimeType,
      },
      user._id
    );

    if (entryMode === 'ai' && resumeSkills.length === 0) {
      try {
        const out = await extractSkillsFromResumeBuffer(
          resumeFile.buffer,
          resumeFile.mimetype || r.mimeType || 'application/octet-stream',
          resumeFile.originalname || r.originalName || 'resume.pdf'
        );
        resumeSkills = Array.isArray(out?.skills) ? out.skills : [];
      } catch (e) {
        logger.warn('Onboard resume skill extraction skipped:', { message: e?.message });
      }
    }
  }

  if (entryMode === 'ai' && resumeSkills.length > 0) {
    const have = new Set((candidate.skills || []).map((s) => String(s.name || '').toLowerCase()));
    const fresh = resumeSkills.filter((s) => s?.name && !have.has(String(s.name).toLowerCase()));
    if (fresh.length > 0) {
      candidate.skills = [...(candidate.skills || []), ...fresh];
    }
  }

  let profileUpdated = false;
  if (entryMode === 'ai' && resumeExperiences.length > 0) {
    const merged = mergePublicApplyExperiences(candidate.experiences, resumeExperiences);
    if (merged !== candidate.experiences) {
      candidate.experiences = merged;
      profileUpdated = true;
    }
  }
  if (entryMode === 'ai' && resumeQualifications.length > 0) {
    const merged = mergePublicApplyQualifications(candidate.qualifications, resumeQualifications);
    if (merged !== candidate.qualifications) {
      candidate.qualifications = merged;
      profileUpdated = true;
    }
  }
  if (entryMode === 'ai' && resumeSocialLinks.length > 0) {
    const merged = mergePublicApplySocialLinks(candidate.socialLinks, resumeSocialLinks);
    if (merged !== candidate.socialLinks) {
      candidate.socialLinks = merged;
      profileUpdated = true;
    }
  }

  if (profileUpdated || (entryMode === 'ai' && resumeSkills.length > 0)) {
    await candidate.save();
  }

  return candidate;
}

/** Attach multipart cover letter to candidate versioned slot (public apply / onboard). */
export async function attachPublicApplyCoverLetter(candidate, user, files) {
  if (!files?.coverLetter?.[0] || !candidate) return candidate;

  const { uploadFileToS3 } = await import('./upload.service.js');
  const clFile = files.coverLetter[0];
  const r = await uploadFileToS3(clFile, user._id, 'candidate-documents');
  await attachVersionedSlotUploadToCandidate(
    candidate,
    'cover-letter',
    {
      url: r.url,
      key: r.key,
      originalName: r.originalName,
      size: r.size,
      mimeType: r.mimeType,
    },
    user._id
  );
  logger.info('✅ Cover letter document attached to candidate profile');
  return candidate;
}
