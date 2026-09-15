import Joi from 'joi';
import { INTERVIEW_NOTICE_VERSION } from '../constants/interviewNotices.js';

export const recordMeetingConsent = {
  params: Joi.object().keys({
    roomName: Joi.string().trim().min(1).max(128).required(),
  }),
  body: Joi.object().keys({
    noticeVersion: Joi.string().trim().default(INTERVIEW_NOTICE_VERSION),
    recording: Joi.boolean().required(),
    transcription: Joi.boolean().required(),
    aiEvaluation: Joi.boolean().required(),
  }),
};
