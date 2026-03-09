import logger from '../config/logger.js';
import bolnaService from './bolna.service.js';
import callRecordService from './callRecord.service.js';

const STATUS_MAP = {
  done: 'completed',
  finished: 'completed',
  ended: 'completed',
  success: 'completed',
  error: 'failed',
  errored: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  stopped: 'failed',
  initiate: 'initiated',
  initiated: 'initiated',
  'no-answer': 'no_answer',
  'call-disconnected': 'call_disconnected',
  'in-progress': 'in_progress',
  'balance-low': 'failed',
  queued: 'initiated',
  ringing: 'in_progress',
};

function normalizeStatus(status) {
  if (!status) return null;
  const s = String(status).toLowerCase().trim();
  return STATUS_MAP[s] || s;
}

async function runCallHistorySync() {
  try {
    logger.debug('Starting scheduled Call Records (Bolna) sync...');

    const backfillResult = await callRecordService.backfillFromBolna({ maxPages: 2 });
    if (backfillResult.backfilled > 0) {
      logger.debug(`Backfilled ${backfillResult.backfilled} new call record(s) from Bolna`);
    }

    const recordsToSync = await callRecordService.findCallRecordsToSyncForCron({ limit: 1000 });
    if (!recordsToSync.length) {
      logger.debug('No call records to sync');
      return;
    }

    const executionIds = [...new Set(recordsToSync.map((r) => r.executionId).filter(Boolean))];
    const limitIds = executionIds.slice(0, 50);

    let syncedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;

    for (const executionId of limitIds) {
      try {
        const result = await bolnaService.getExecutionDetails(executionId);
        if (!result.success || !result.details) {
          errorCount += 1;
          continue;
        }
        const executionData = result.details;

        const status = normalizeStatus(executionData.status || executionData.smart_status);
        const telephonyData = executionData.telephony_data || {};
        let conversationDuration =
          executionData.conversation_time ??
          executionData.duration ??
          telephonyData.duration ??
          telephonyData.conversation_duration;
        if (conversationDuration != null) {
          conversationDuration = parseInt(conversationDuration, 10);
          if (Number.isNaN(conversationDuration)) conversationDuration = null;
        }
        const recordingUrl = telephonyData.recording_url || executionData.recording_url;
        const transcript = executionData.transcript || executionData.transcription;
        const fromPhoneNumber = telephonyData.from_number || executionData.agent_number || null;
        let errorMessage = executionData.error_message;
        if (errorMessage && typeof errorMessage === 'string') {
          try {
            const parsed = JSON.parse(errorMessage);
            if (parsed && parsed.message) errorMessage = parsed.message;
          } catch {
            /* ignore parse error */
          }
        }
        const endedStatuses = [
          'completed',
          'failed',
          'no_answer',
          'busy',
          'stopped',
          'error',
          'call_disconnected',
          'balance-low',
        ];
        const completedAt = endedStatuses.includes(status)
          ? executionData.updated_at
            ? new Date(executionData.updated_at)
            : executionData.initiated_at
              ? new Date(executionData.initiated_at)
              : new Date()
          : null;

        const recordsWithThisExecution = recordsToSync.filter((r) => r.executionId === executionId);
        for (const record of recordsWithThisExecution) {
          const statusChanged = status && status !== record.status;
          const isTerminal = ['failed', 'error', 'completed'].includes(record.status);
          const hasNewData =
            (errorMessage && errorMessage !== record.errorMessage) ||
            (recordingUrl && recordingUrl !== record.recordingUrl) ||
            (transcript && transcript !== (record.transcript || record.conversationTranscript)) ||
            (conversationDuration != null && conversationDuration !== record.duration) ||
            (fromPhoneNumber && fromPhoneNumber !== record.fromPhoneNumber);
          const shouldBackfillFrom = fromPhoneNumber && !record.fromPhoneNumber;

          if (statusChanged || (isTerminal && hasNewData) || shouldBackfillFrom) {
            const updateData = {};
            if (statusChanged) updateData.status = status;
            if (fromPhoneNumber && (!record.fromPhoneNumber || fromPhoneNumber !== record.fromPhoneNumber)) {
              updateData.fromPhoneNumber = fromPhoneNumber;
            }
            if (conversationDuration != null && conversationDuration !== record.duration) {
              updateData.duration = conversationDuration;
            }
            if (recordingUrl && recordingUrl !== record.recordingUrl) updateData.recordingUrl = recordingUrl;
            if (transcript && transcript !== record.transcript) updateData.transcript = transcript;
            if (
              (status === 'failed' ||
                status === 'error' ||
                record.status === 'failed' ||
                record.status === 'error') &&
              errorMessage
            ) {
              updateData.errorMessage = String(errorMessage);
            }
            if (endedStatuses.includes(status || record.status) && !record.completedAt && completedAt) {
              updateData.completedAt = completedAt;
            }
            if (executionData.user_data?.organisation) {
              updateData.businessName = String(executionData.user_data.organisation).trim();
            } else if (executionData.user_data?.name) {
              updateData.businessName = String(executionData.user_data.name).trim();
            } else if (executionData.user_data?.candidate_name) {
              updateData.businessName = String(executionData.user_data.candidate_name).trim();
            }
            if (executionData.extracted_data && typeof executionData.extracted_data === 'object') {
              updateData.extractedData = executionData.extracted_data;
            }
            const execAgentId = executionData.agent_id ?? executionData.agentId;
            if (execAgentId && (!record.agentId || record.agentId !== execAgentId)) {
              updateData.agentId = String(execAgentId).trim();
            }

            if (Object.keys(updateData).length > 0) {
              await callRecordService.updateCallRecordByExecutionId(executionId, updateData);
              updatedCount += 1;
            }
          }
        }
        syncedCount += 1;
      } catch (err) {
        errorCount += 1;
        logger.error(`Failed to sync execution ${executionId}: ${err.message}`);
      }
    }

    const filled = await callRecordService.fillMissingBusinessNameFromJobs(50);
    if (filled.updated > 0) {
      logger.debug(`Filled business name for ${filled.updated} call record(s) from Jobs`);
    }

    logger.debug(
      `Call history sync completed: ${syncedCount} executions synced, ${updatedCount} records updated, ${errorCount} errors`
    );
  } catch (err) {
    logger.error(`Error in scheduled Call Records sync: ${err.message}`);
  }
}

function startCallRecordSyncScheduler(intervalMinutes = 1) {
  const intervalMs = intervalMinutes * 60 * 1000;
  runCallHistorySync();
  const id = setInterval(runCallHistorySync, intervalMs);
  logger.info(`Call history (Bolna) sync scheduler started (every ${intervalMinutes} min)`);
  return id;
}

function stopCallRecordSyncScheduler(id) {
  if (id) {
    clearInterval(id);
    logger.info('Call history (Bolna) sync scheduler stopped');
    return true;
  }
  return false;
}

export { runCallHistorySync, startCallRecordSyncScheduler, stopCallRecordSyncScheduler };

