import http from 'http';
import mongoose from 'mongoose';
import app from './app.js';
import config from './config/config.js';
import logger from './config/logger.js';
import { initSocket } from './services/chatSocket.service.js';
import { startAttendanceScheduler, stopAttendanceScheduler } from './services/attendance.scheduler.js';
import { startCandidateScheduler, stopCandidateScheduler } from './services/candidate.scheduler.js';
import {
  startJobVerificationCallScheduler,
  stopJobVerificationCallScheduler,
} from './services/jobVerificationCall.scheduler.js';
import {
  startCallRecordSyncScheduler,
  stopCallRecordSyncScheduler,
} from './services/callRecordSync.scheduler.js';
import { startMeetingScheduler, stopMeetingScheduler } from './services/meeting.scheduler.js';
import applicationVerificationCallScheduler from './services/applicationVerificationCall.scheduler.js';
import { logBolnaAgentConfigHealth } from './utils/bolnaAgentConfig.js';
import { seedVoiceAgentsFromEnv } from './services/voiceAgent.service.js';

let server;
let candidateSchedulerId;
let jobVerificationSchedulerId;
let callRecordSyncSchedulerId;
let applicationVerificationSchedulerId;
const port = config.port || process.env.PORT || 3000;

mongoose
  .connect(config.mongoose.url, config.mongoose.options)
  .then(() => {
    logger.info('Connected to MongoDB');
    logBolnaAgentConfigHealth();
    seedVoiceAgentsFromEnv().catch((e) => logger.warn(`[VoiceAgent] seed skipped: ${e.message}`));
    const httpServer = http.createServer(app);
    if (config.env !== 'test') initSocket(httpServer);
    server = httpServer.listen(port, '0.0.0.0', () => {
      logger.info(`Listening on port ${port}`);
      if (config.env !== 'test') {
        startAttendanceScheduler();
        candidateSchedulerId = startCandidateScheduler(config.candidate?.schedulerIntervalMinutes ?? 60);
        jobVerificationSchedulerId = startJobVerificationCallScheduler(1);
        callRecordSyncSchedulerId = startCallRecordSyncScheduler(1);
        applicationVerificationSchedulerId = applicationVerificationCallScheduler.startApplicationVerificationCallScheduler(2);
        startMeetingScheduler();
      }
    });
  })
  .catch((err) => {
    logger.error('MongoDB connection error', err);
    process.exit(1);
  });

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      stopAttendanceScheduler();
      stopCandidateScheduler(candidateSchedulerId);
      stopJobVerificationCallScheduler(jobVerificationSchedulerId);
      stopCallRecordSyncScheduler(callRecordSyncSchedulerId);
      applicationVerificationCallScheduler.stopApplicationVerificationCallScheduler(applicationVerificationSchedulerId);
      stopMeetingScheduler();
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  logger.error(error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  if (server) {
    server.close();
  }
});
