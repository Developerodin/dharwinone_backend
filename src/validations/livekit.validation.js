import Joi from 'joi';

const getToken = {
  body: Joi.object().keys({
    roomName: Joi.string().required().trim(),
    participantName: Joi.string().optional().trim(),
    participantEmail: Joi.string().optional().email().trim(),
    participantIdentity: Joi.string().optional().trim(),
  }),
};

const startRecording = {
  body: Joi.object().keys({
    roomName: Joi.string().required().trim(),
  }),
};

const stopRecording = {
  body: Joi.object().keys({
    egressId: Joi.string().required().trim(),
    roomName: Joi.string().required().trim(),
  }),
};

const startRecordingPublic = {
  body: Joi.object().keys({
    roomName: Joi.string().required().trim(),
    hostEmail: Joi.string().required().email().trim(),
  }),
};

const stopRecordingPublic = {
  body: Joi.object().keys({
    egressId: Joi.string().required().trim(),
    roomName: Joi.string().required().trim(),
    hostEmail: Joi.string().required().email().trim(),
  }),
};

const getRecordingStatusPublic = {
  params: Joi.object().keys({
    roomName: Joi.string().required().trim(),
  }),
};

const getRecordingStatus = {
  params: Joi.object().keys({
    roomName: Joi.string().required().trim(),
  }),
};

const getWaitingParticipants = {
  params: Joi.object().keys({
    roomName: Joi.string().required().trim(),
  }),
  query: Joi.object().keys({
    hostEmail: Joi.string().optional().email().trim(),
  }),
};

const admitParticipant = {
  body: Joi.object().keys({
    roomName: Joi.string().required().trim(),
    participantIdentity: Joi.string().required().trim(),
    participantName: Joi.string().optional().trim(),
    participantEmail: Joi.string().optional().email().trim(),
    hostEmail: Joi.string().optional().email().trim(),
  }),
};

const removeParticipant = {
  body: Joi.object().keys({
    roomName: Joi.string().required().trim(),
    participantIdentity: Joi.string().required().trim(),
    hostEmail: Joi.string().optional().email().trim(),
  }),
};

export {
  getToken,
  startRecording,
  stopRecording,
  getRecordingStatus,
  startRecordingPublic,
  stopRecordingPublic,
  getRecordingStatusPublic,
  getWaitingParticipants,
  admitParticipant,
  removeParticipant,
};
