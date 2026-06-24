import http from 'http';
import mongoose from 'mongoose';
import app from './app.js';
import config from './config/config.js';
import logger from './config/logger.js';
import { initSocket } from './services/chatSocket.service.js';
import { startAttendanceScheduler, stopAttendanceScheduler } from './services/attendance.scheduler.js';
import { startCandidateScheduler, stopCandidateScheduler } from './services/employee.scheduler.js';
import {
  startJobVerificationCallScheduler,
  stopJobVerificationCallScheduler,
} from './services/jobVerificationCall.scheduler.js';
import {
  startCallRecordSyncScheduler,
  stopCallRecordSyncScheduler,
} from './services/callRecordSync.scheduler.js';
import { startMeetingScheduler, stopMeetingScheduler } from './services/meeting.scheduler.js';
import { startRecordingScheduler, stopRecordingScheduler } from './services/recording.scheduler.js';
import {
  startRecordingDiscoveryScheduler,
  stopRecordingDiscoveryScheduler,
} from './services/recordingDiscovery.scheduler.js';
import { getEgressClient } from './services/livekit.service.js';
import applicationVerificationCallScheduler from './services/applicationVerificationCall.scheduler.js';
import { logBolnaAgentConfigHealth } from './utils/bolnaAgentConfig.js';
import { seedVoiceAgentsFromEnv } from './services/voiceAgent.service.js';
import { registerEmbeddingHooks, runEmbeddingBackfill } from './services/embeddingSync.scheduler.js';
import {
  startMemorySweepScheduler,
  stopMemorySweepScheduler,
} from './services/chatAssistant/memorySweep.scheduler.js';
import { startSummaryWorker, stopSummaryWorker } from './queues/summaryWorker.js';
import { startStuckDispatchSweeper, stopStuckDispatchSweeper } from './jobs/stuckDispatchSweeper.js';
import { startStuckFinalizeSweeper, stopStuckFinalizeSweeper } from './jobs/stuckFinalizeSweeper.js';
import { startRetentionEnforcer, stopRetentionEnforcer } from './jobs/retentionEnforcer.js';
import { startEmailNotificationPoller, stopEmailNotificationPoller } from './jobs/emailNotificationPoller.js';
import { canUseRedis } from './config/redis.js';
import {
  startWorkforceReconciliationScheduler,
  stopWorkforceReconciliationScheduler,
} from './jobs/workforceReconciliation.scheduler.js';
import {
  startSalesAgentCacheReconcilerScheduler,
  stopSalesAgentCacheReconcilerScheduler,
} from './jobs/salesAgentCacheReconciler.scheduler.js';

let server;
let candidateSchedulerId;
let jobVerificationSchedulerId;
let callRecordSyncSchedulerId;
let applicationVerificationSchedulerId;
let recordingDiscoverySchedulerId;
let redisFeaturesEnabled = false;
const port = config.port || process.env.PORT || 3000;

mongoose
  .connect(config.mongoose.url, config.mongoose.options)
  .then(() => {
    logger.info('Connected to MongoDB');
    logBolnaAgentConfigHealth();
    seedVoiceAgentsFromEnv().catch((e) => logger.warn(`[VoiceAgent] seed skipped: ${e.message}`));
    const httpServer = http.createServer(app);
    if (config.env !== 'test') initSocket(httpServer);
    server = httpServer.listen(port, '0.0.0.0', async () => {
      logger.info(`Listening on port ${port}`);
      if (config.env !== 'test') {
        redisFeaturesEnabled = await canUseRedis();
        if (!redisFeaturesEnabled) {
          logger.warn('[Startup] Redis unavailable or disabled. Continuing without Redis-dependent workers/queues.');
        }
        startAttendanceScheduler();
        const candidateSchedulerMinutes = Math.min(
          1440,
          Math.max(1, Number(config.candidate?.schedulerIntervalMinutes) || 5)
        );
        candidateSchedulerId = startCandidateScheduler(candidateSchedulerMinutes);
        jobVerificationSchedulerId = startJobVerificationCallScheduler(1);
        callRecordSyncSchedulerId = startCallRecordSyncScheduler(1);
        applicationVerificationSchedulerId = applicationVerificationCallScheduler.startApplicationVerificationCallScheduler(2);
        startMeetingScheduler();
        startRecordingScheduler(getEgressClient());
        recordingDiscoverySchedulerId = startRecordingDiscoveryScheduler();
        registerEmbeddingHooks();
        runEmbeddingBackfill().catch((err) => logger.error(`[EmbeddingSync] backfill failed: ${err?.stack || err?.message || String(err)}`));
        startMemorySweepScheduler({ intervalHours: 24 });
        if (redisFeaturesEnabled) {
          startSummaryWorker();
        }
        startStuckDispatchSweeper();
        if (redisFeaturesEnabled) {
          startStuckFinalizeSweeper();
        }
        startRetentionEnforcer();
        startWorkforceReconciliationScheduler({ intervalHours: 24 });
        startSalesAgentCacheReconcilerScheduler({ intervalHours: 24 });
        startEmailNotificationPoller();
      }
    });
  })
  .catch((err) => {
    const hint =
      'MongoDB did not respond in time. Check MONGODB_URL in .env (reachable host/port), that MongoDB is running ' +
      '(e.g. local mongod or Docker), and Atlas IP access list / VPN if using Atlas.';
    logger.error(`${hint} Details: ${err?.message || err}`);
    if (err?.stack) logger.error(err.stack);
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
      stopRecordingScheduler();
      stopRecordingDiscoveryScheduler(recordingDiscoverySchedulerId);
      stopMemorySweepScheduler();
      if (redisFeaturesEnabled) {
        stopSummaryWorker().catch(() => {});
      }
      stopStuckDispatchSweeper();
      if (redisFeaturesEnabled) {
        stopStuckFinalizeSweeper();
      }
      stopRetentionEnforcer();
      stopWorkforceReconciliationScheduler();
      stopSalesAgentCacheReconcilerScheduler();
      stopEmailNotificationPoller();
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
