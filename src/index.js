import mongoose from 'mongoose';
import app from './app.js';
import config from './config/config.js';
import logger from './config/logger.js';
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
    server = app.listen(port, '0.0.0.0', () => {
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
    logger.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });

const exitHandler = () => {
  stopAttendanceScheduler();
  stopCandidateScheduler(candidateSchedulerId);
  stopJobVerificationCallScheduler(jobVerificationSchedulerId);
  stopCallRecordSyncScheduler(callRecordSyncSchedulerId);
  if (applicationVerificationSchedulerId) {
    clearInterval(applicationVerificationSchedulerId);
  }
  stopMeetingScheduler();

  if (server) {
    server.close(() => {
      logger.info('Server closed');
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

