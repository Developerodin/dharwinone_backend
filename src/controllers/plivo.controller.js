import httpStatus from 'http-status';
import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import plivoService from '../services/plivo.service.js';
import telephonyService from '../services/telephony.service.js';
import callRecordService from '../services/callRecord.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import * as companyPhoneNumberService from '../services/companyPhoneNumber.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getAvailableNumbers = catchAsync(async (req, res) => {
  const {
    countryIso,
    type,
    pattern,
    services,
    city,
    region,
    limit,
    offset,
    pageToken,
    postalCode,
    nearNumber,
    distance,
  } = req.query;
  const result = await telephonyService.searchAvailableNumbers({
    countryIso,
    type,
    pattern,
    services,
    city,
    region,
    limit,
    offset,
    pageToken,
    postalCode,
    nearNumber,
    distance,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to search available numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    hasMore: result.hasMore,
    offset: result.offset,
    limit: result.limit,
    total: result.total,
    nextPageToken: result.nextPageToken,
    provider: result.provider || telephonyService.getProviderName(),
  });
});

const buyNumber = catchAsync(async (req, res) => {
  const { number } = req.body;
  const result = await telephonyService.buyNumber(number);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to buy Plivo number');
  }

  await companyPhoneNumberService.recordCompanyPhoneNumberPurchase(req.user, result);

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.PHONE_NUMBER_PURCHASE,
    EntityTypes.PHONE_NUMBER,
    result.number,
    { number: result.number },
    req
  );

  res.status(httpStatus.OK).send({
    success: true,
    number: result.number,
    message: result.message,
  });
});

const getOwnedNumbers = catchAsync(async (req, res) => {
  const { type, alias, limit, offset } = req.query;
  const result = await telephonyService.listOwnedNumbers({ type, alias, limit, offset });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to list Plivo numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    total: result.total,
    provider: telephonyService.getProviderName(),
  });
});

/**
 * POST /v1/plivo/call — start a click-to-call bridge. Plivo rings the agent's own
 * phone, then dials the target showing the bought number as caller ID.
 */
const placeCall = catchAsync(async (req, res) => {
  const { toNumber, agentPhone, callerId } = req.body;
  const result = await telephonyService.placeBridgeCall({ toNumber, agentPhone, callerId });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to place call');
  }

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.PHONE_CALL_PLACE,
    EntityTypes.PHONE_NUMBER,
    toNumber,
    { toNumber, callerId },
    req
  );

  // Seed a dialer CallRecord (keyed by the provider call id) so the bridge call
  // shows in CRM call records; on Twilio the recording webhook later attaches
  // the audio to this same row by CallSid.
  if (result.requestUuid) {
    callRecordService
      .upsertDialerCallRecord({
        executionId: result.requestUuid,
        createdBy: req.user.id,
        toPhoneNumber: toNumber,
        fromPhoneNumber: callerId,
        status: 'initiated',
        direction: 'outbound',
        provider: telephonyService.getProviderName(),
      })
      .catch((e) => logger.warn(`[dialer] bridge record seed failed: ${e?.message}`));
  }

  res.status(httpStatus.OK).send({
    success: true,
    requestUuid: result.requestUuid,
    message: result.message,
  });
});

/**
 * GET /v1/public/plivo/answer — Plivo fetches this when the agent's phone is
 * answered. No auth (Plivo's servers hit it); the `sig` HMAC gates it so only
 * URLs our backend minted are honored. Returns Plivo bridge XML.
 */
const answerCall = catchAsync(async (req, res) => {
  const { to, callerId, sig } = req.query;
  if (!telephonyService.verifyCallSignature(to, callerId, sig)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Invalid call signature');
  }
  res.type('text/xml').send(telephonyService.bridgeAnswerXml({ toNumber: to, callerId }));
});

/**
 * POST /v1/plivo/sdk-token — mint a short-lived, outbound-only WebRTC access
 * token for the browser softphone. Self-provisions the shared Plivo Application
 * + endpoint on first call.
 */
const getSdkToken = catchAsync(async (req, res) => {
  const result = await telephonyService.mintBrowserToken({ uid: req.user.id });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to mint WebRTC token');
  }
  res.status(httpStatus.OK).send({
    success: true,
    token: result.token,
    username: result.username,
    identity: result.identity,
    provider: telephonyService.getProviderName(),
  });
});

/**
 * POST /v1/public/plivo/sdk-answer — Plivo fetches this when a browser-SDK call
 * is placed (no auth — Plivo's servers hit it). Plivo passes the dialed number as
 * `To` and the chosen caller ID as the `X-PH-callerId` custom header. A real call
 * only reaches here from our token-authenticated endpoint; Plivo also enforces
 * that the caller ID is an owned number on <Dial>.
 */
const sdkAnswer = catchAsync(async (req, res) => {
  logger.info(
    `Plivo sdk-answer REQUEST method=${req.method} url=${req.originalUrl} pathIntentLen=${typeof req.params?.intent === 'string' ? req.params.intent.length : 0}`
  );
  const src = { ...req.query, ...req.body };
  const pathIntent = typeof req.params?.intent === 'string' ? req.params.intent : '';
  const to =
    src.To ??
    src.to ??
    src.DialBLegTo ??
    src['SIP-H-To'] ??
    src['X-Destination'] ??
    src.Dialed ??
    '';
  const callerId =
    src['X-PH-callerId'] ??
    src['X-PH-CallerId'] ??
    src['x-ph-callerid'] ??
    src.CallerId ??
    src.callerId ??
    src.From ??
    '';
  const intentToken =
    pathIntent ||
    (src['X-PH-intent'] ??
      src['X-PH-Intent'] ??
      src['x-ph-intent'] ??
      src.intent ??
      '');
  logger.info(
    `Plivo sdk-answer hit mongoReady=${mongoose.connection.readyState === 1} pathIntent=${Boolean(pathIntent)} keys=${Object.keys(src).join(',')}`
  );
  const xml = await telephonyService.sdkAnswerXml({ to, callerId, intentToken });
  if (!xml) {
    logger.warn(
      `Plivo sdk-answer RESULT xmlType=Hangup to=${String(to).slice(0, 40)} callerId=${String(callerId).slice(0, 20)} intent=${intentToken ? 'yes' : 'no'} intentTail=${intentToken ? String(intentToken).slice(-8) : 'none'} keys=${Object.keys(src).join(',')}`
    );
  } else {
    logger.info(
      `Plivo sdk-answer RESULT xmlType=Dial to=…${String(to).slice(-4)} intent=${intentToken ? 'yes' : 'no'} intentTail=${intentToken ? String(intentToken).slice(-8) : 'none'}`
    );
  }
  // Don't clear the intent inline and don't reset the answer_url: Plivo can fetch
  // the answer_url more than once per call, and a premature delete/reset turns the
  // second fetch into a Hangup. The 120s TTL (and dest-keyed upsert on the next
  // call) cleans it up. answer_url stays static — no reset needed.
  res.type('text/xml').send(xml || '<Response><Hangup/></Response>');
});

/**
 * POST /v1/plivo/browser-call-intent — register dest+callerId before browser SDK
 * client.call(). Plivo's sdk-answer webhook often omits X-PH-callerId.
 */
const postBrowserCallIntent = catchAsync(async (req, res) => {
  const { toNumber, callerId } = req.body;
  const result = await telephonyService.registerBrowserCallIntent({ toNumber, callerId });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_REQUEST, result.error || 'Invalid browser call intent');
  }
  res.status(httpStatus.OK).send({ intent: result.intent });
});

/**
 * POST /v1/plivo/recording — toggle live recording on an in-progress browser
 * call. Body: { callSid, recording: boolean }. Twilio-only (active provider).
 */
const setCallRecording = catchAsync(async (req, res) => {
  const { callSid, recording } = req.body;
  const result = await telephonyService.setRecording({ callSid, recording });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to toggle recording');
  }
  res.status(httpStatus.OK).send({
    success: true,
    recording: Boolean(recording),
    recordingSid: result.data?.sid,
  });
});

export {
  getAvailableNumbers,
  buyNumber,
  getOwnedNumbers,
  placeCall,
  setCallRecording,
  answerCall,
  getSdkToken,
  sdkAnswer,
  postBrowserCallIntent,
};
