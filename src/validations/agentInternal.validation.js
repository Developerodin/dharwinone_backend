import Joi from 'joi';

const runIdSchema = Joi.string().pattern(/^[a-f0-9]{16}$/);

const utteranceV2Schema = Joi.object({
  utteranceId: Joi.string().max(128).required(),
  participantIdentity: Joi.string().required(),
  participantSid: Joi.string().allow(null, ''),
  trackSid: Joi.string().allow(null, ''),
  displayName: Joi.string().allow(null, ''),
  text: Joi.string().min(1).max(5000).required(),
  confidence: Joi.number().min(0).max(1).allow(null),
  language: Joi.string().default('en'),
  sttStartSec: Joi.number().allow(null),
  sttDurationSec: Joi.number().allow(null),
  startedAtEpochMs: Joi.number().integer().required(),
  endedAtEpochMs: Joi.number().integer().required(),
}).custom((val, helpers) => {
  if (val.endedAtEpochMs < val.startedAtEpochMs) {
    return helpers.error('any.invalid');
  }
  return val;
});

export const registerRunBody = {
  body: Joi.object({
    runId: runIdSchema.required(),
    agentIdentity: Joi.string().required(),
    protocolVersion: Joi.number().valid(2).required(),
    agentBuild: Joi.string().allow(null, ''),
    sttProvider: Joi.string().required(),
    sttModel: Joi.string().allow(null, ''),
    language: Joi.string().default('en'),
    startedAtEpochMs: Joi.number().integer().required(),
  }),
};

export const transcriptBatchBody = {
  body: Joi.object({
    runId: runIdSchema.required(),
    batchSeq: Joi.number().integer().min(0).required(),
    utterances: Joi.array().items(utteranceV2Schema).min(1).max(200).required(),
  }),
};

export const finalizeV2BodySchema = Joi.object({
  runId: runIdSchema.required(),
  ackedBatchSeqs: Joi.array().items(Joi.number().integer().min(0)).required(),
  utteranceCount: Joi.number().integer().min(0).required(),
  sttStreamClosures: Joi.number().integer().min(0).required(),
  reason: Joi.string().valid('shutdown', 'deadline', 'max_runtime').required(),
});
