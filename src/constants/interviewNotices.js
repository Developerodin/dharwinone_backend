export const INTERVIEW_NOTICE_VERSION = 'draft-2026-09-v1';

/** Legal must approve before production. */
export const INTERVIEW_NOTICES = {
  [INTERVIEW_NOTICE_VERSION]: {
    recording: {
      title: 'Recording',
      body:
        'This interview may be recorded as audio and video for hiring review. Recordings are stored securely and accessed only by authorised staff.',
    },
    transcription: {
      title: 'Transcription',
      body:
        'Speech may be transcribed automatically to support interview notes and summaries. Transcripts are not shared with third parties for advertising.',
    },
    aiEvaluation: {
      title: 'AI-assisted evaluation (optional)',
      body:
        'If you opt in, an AI system may analyse the transcript against job criteria to produce advisory scores. A human makes the final decision; you may request deletion of AI outputs.',
    },
    contact:
      'Questions or deletion requests: contact your recruiter or privacy@dharwinone.com (draft — legal review required).',
  },
};

export const getInterviewNotice = (version = INTERVIEW_NOTICE_VERSION) =>
  INTERVIEW_NOTICES[version] || null;
