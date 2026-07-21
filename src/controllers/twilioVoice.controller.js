/**
 * Public Twilio Voice webhooks (no user JWT — validated by X-Twilio-Signature).
 * Voice URLs MUST return TwiML (text/xml), never JSON.
 */

import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import logger from '../config/logger.js';
import twilioService from '../services/twilio.service.js';
import telephonyService from '../services/telephony.service.js';
import callRecordService from '../services/callRecord.service.js';
import { archiveTwilioRecording } from '../services/callRecordingArchive.service.js';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Parent browser leg CallSid — child PSTN legs also send ParentCallSid. */
function resolveDialerExecutionId(body) {
  const parent = body?.ParentCallSid || body?.parentCallSid || '';
  const self = body?.CallSid || body?.callSid || '';
  return String(parent || self).trim();
}

function sendTwiml(res, xml) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(httpStatus.OK).send(xml);
}

async function resolveOutboundCallerId(body) {
  const raw =
    body.CallerId ||
    body.callerId ||
    body['X-PH-callerId'] ||
    body['X-PH-CallerId'] ||
    '';
  let callerId = twilioService.toE164(raw);
  if (!callerId) {
    callerId = twilioService.toE164(twilioService.getConfig().phoneNumber);
  }
  const check = await telephonyService.validateCallerId(callerId);
  if (!check.valid) {
    logger.warn(`[Twilio] outbound rejected callerId: ${check.error}`);
    return null;
  }
  return check.callerId || callerId;
}

/** POST /v1/public/twilio/voice — TwiML App Voice URL (browser/mobile outbound). */
const outboundVoice = catchAsync(async (req, res) => {
  try {
    const body = req.body || {};
    const fromClient = String(body.From || '');
    const destination = twilioService.toDialE164(body.To || body.PhoneNumber || '');
    const callerId = await resolveOutboundCallerId(body);

    if (!destination || !callerId) {
      return sendTwiml(res, twilioService.buildHangupTwiml('Unable to connect your call.'));
    }

    logger.info('[Twilio] voice outbound', {
      from: fromClient.slice(0, 24),
      to: destination,
      callerId,
    });

    // Seed a dialer CallRecord keyed by the Twilio CallSid so the call (and its
    // recording, persisted later by the recording webhook) shows in CRM call
    // records. createdBy comes from the browser SDK identity (client:user_<id>).
    const callSid = body.CallSid || '';
    if (callSid) {
      callRecordService
        .upsertDialerCallRecord({
          executionId: callSid,
          createdBy: twilioService.userIdFromClient(fromClient) || null,
          toPhoneNumber: destination,
          fromPhoneNumber: callerId,
          status: 'initiated',
          direction: 'outbound',
        })
        .catch((e) => logger.warn(`[Twilio] dialer record seed failed: ${e?.message}`));
    }

    return sendTwiml(res, twilioService.buildOutboundTwiml({ to: destination, callerId }));
  } catch (err) {
    logger.warn(`[Twilio] voice outbound error: ${err?.message}`);
    return sendTwiml(res, twilioService.buildHangupTwiml());
  }
});

/** POST /v1/public/twilio/voice/inbound — purchased number Voice URL (PSTN inbound). */
const inboundVoice = catchAsync(async (req, res) => {
  try {
    const body = req.body || {};
    const calledNumber = body.To || body.Called || '';
    const callerNumber = body.From || body.Caller || '';
    const callSid = body.CallSid || '';
    const identity = await twilioService.resolveInboundIdentity(calledNumber);
    if (!identity) {
      logger.info('[Twilio] voice inbound — TWILIO_INBOUND_DEFAULT_USER unset, not routed', { calledNumber });
      return sendTwiml(
        res,
        twilioService.buildHangupTwiml('This number is not configured for inbound calls yet.'),
      );
    }
    logger.info('[Twilio] voice inbound → client', { calledNumber, callerNumber, identity });
    return sendTwiml(
      res,
      twilioService.buildInboundToClientTwiml({
        identity,
        from: callerNumber,
        to: calledNumber,
        callSid,
      }),
    );
  } catch (err) {
    logger.warn(`[Twilio] voice inbound error: ${err?.message}`);
    return sendTwiml(res, twilioService.buildHangupTwiml());
  }
});

/** POST /v1/public/twilio/bridge-answer — agent answered click-to-call; dial destination. */
const bridgeAnswer = catchAsync(async (req, res) => {
  const q = { ...req.query, ...req.body };
  const to = twilioService.toDialE164(q.to || q.To || '');
  const callerId = twilioService.toE164(q.callerId || q.CallerId || '');
  const sig = q.sig || q.Sig || '';

  if (!telephonyService.verifyBridgeCallSignature(to, callerId, sig)) {
    logger.warn('[Twilio] bridge-answer rejected: invalid signature');
    return sendTwiml(res, twilioService.buildHangupTwiml('Invalid call signature.'));
  }

  const check = await telephonyService.validateCallerId(callerId);
  if (!check.valid || !to) {
    logger.warn('[Twilio] bridge-answer rejected: invalid caller or destination');
    return sendTwiml(res, twilioService.buildHangupTwiml('Unable to connect your call.'));
  }

  return sendTwiml(
    res,
    telephonyService.bridgeWebhookResponse({ toNumber: to, callerId: check.callerId || callerId }),
  );
});

/** POST /v1/public/twilio/call-status — status + Dial action callback. */
const callStatusWebhook = catchAsync(async (req, res) => {
  const body = req.body || {};
  // On a <Dial action> callback the parent CallStatus is still `in-progress`;
  // the dialed leg's real outcome (busy / no-answer / completed / failed) is in
  // DialCallStatus — prefer it so the CallRecord reflects the carrier result.
  const status = body.DialCallStatus || body.CallStatus;
  const durationRaw = body.CallDuration != null ? body.CallDuration : body.DialCallDuration;
  logger.info('[Twilio] call-status', {
    callSid: body.CallSid,
    status,
    dialCallStatus: body.DialCallStatus,
    direction: body.Direction,
  });
  const executionId = resolveDialerExecutionId(body);
  if (executionId) {
    // `From` is `client:user_<id>` for browser legs — don't overwrite the phone.
    const fromIsPhone = body.From && !String(body.From).startsWith('client:');
    callRecordService
      .upsertDialerCallRecord({
        executionId,
        status,
        duration: durationRaw != null ? parseInt(durationRaw, 10) : undefined,
        toPhoneNumber: body.To && !String(body.To).startsWith('client:') ? body.To : undefined,
        fromPhoneNumber: fromIsPhone ? body.From : undefined,
        direction: 'outbound',
      })
      .catch((e) => logger.warn(`[Twilio] call-status persist failed: ${e?.message}`));
  }
  return sendTwiml(res, EMPTY_TWIML);
});

/** POST /v1/public/twilio/recording — recordingStatusCallback from <Dial record>. */
const recordingWebhook = catchAsync(async (req, res) => {
  const body = req.body || {};
  logger.info('[Twilio] recording callback', {
    callSid: body.CallSid,
    recordingSid: body.RecordingSid,
    status: body.RecordingStatus,
  });
  const callSid = resolveDialerExecutionId(body);
  const recordingUrl = body.RecordingUrl || '';
  if (callSid && String(body.RecordingStatus || '').toLowerCase() === 'completed' && recordingUrl) {
    // Ensure a row exists, then mirror the Twilio media to S3 + link it. Both
    // best-effort: a 200 must still go back to Twilio promptly.
    callRecordService
      .upsertDialerCallRecord({
        executionId: callSid,
        toPhoneNumber: body.To && !String(body.To).startsWith('client:') ? body.To : undefined,
        duration: body.RecordingDuration != null ? parseInt(body.RecordingDuration, 10) : undefined,
        direction: 'outbound',
      })
      .then(() => archiveTwilioRecording(callSid, recordingUrl))
      .catch((e) => logger.warn(`[Twilio] recording archive failed: ${e?.message}`));

    // Kick off Conversational Intelligence on the finished recording. The
    // Intelligence Service webhook (intelligenceWebhook) persists the results.
    if (body.RecordingSid && twilioService.isIntelligenceConfigured()) {
      twilioService
        .createTranscript({ recordingSid: body.RecordingSid, callSid })
        .then((r) => {
          if (!r.success) {
            logger.warn(`[Twilio] intelligence transcript create failed: ${r.error}`);
            return null;
          }
          return callRecordService.updateCallRecordByExecutionId(callSid, {
            'intelligence.transcriptSid': r.sid,
            'intelligence.status': r.status || 'queued',
            'intelligence.requestedAt': new Date(),
          });
        })
        .catch((e) => logger.warn(`[Twilio] intelligence transcript create failed: ${e?.message}`));
    }
  }
  return res.status(httpStatus.OK).json({ success: true });
});

/**
 * POST /v1/public/twilio/intelligence — Intelligence Service webhook_url (JSON).
 * Treats the payload as a ping: results are fetched from the Twilio API by
 * transcriptSid, and the CallRecord is resolved via customerKey (our CallSid).
 */
const intelligenceWebhook = catchAsync(async (req, res) => {
  const body = req.body || {};
  const transcriptSid = String(body.transcript_sid || body.TranscriptSid || '').trim();
  logger.info('[Twilio] intelligence webhook', { transcriptSid, event: body.event_type });
  if (!/^GT[0-9a-f]{32}$/i.test(transcriptSid)) {
    return res.status(httpStatus.OK).json({ success: true, ignored: true });
  }

  const results = await twilioService.fetchTranscriptResults(transcriptSid);
  if (!results.success) {
    // Non-2xx so Twilio retries transient API failures.
    logger.warn(`[Twilio] intelligence fetch failed for ${transcriptSid}: ${results.error}`);
    return res.status(httpStatus.BAD_GATEWAY).json({ success: false });
  }

  const executionId = String(results.customerKey || '').trim();
  if (!executionId) {
    logger.warn(`[Twilio] intelligence transcript ${transcriptSid} has no customerKey — cannot map to a call`);
    return res.status(httpStatus.OK).json({ success: true, ignored: true });
  }

  const update = { 'intelligence.status': results.status };
  if (results.status === 'completed') {
    update['intelligence.summary'] = results.summary || null;
    update['intelligence.completedAt'] = new Date();
    if (results.transcript) update.transcript = results.transcript;
  }
  await callRecordService.updateCallRecordByExecutionId(executionId, update);
  return res.status(httpStatus.OK).json({ success: true });
});

export { outboundVoice, inboundVoice, bridgeAnswer, callStatusWebhook, recordingWebhook, intelligenceWebhook };
