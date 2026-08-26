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
    requiresVerification: result.requiresVerification,
    requiresBundle: result.requiresBundle,
    retailMonthlyPrice: result.retailMonthlyPrice,
    currency: result.currency,
  });
});

/** GET /v1/plivo/numbers/countries — Twilio-driven country catalogue + retail/regulatory flags. */
const getCountries = catchAsync(async (req, res) => {
  const result = await telephonyService.listAvailableCountries();
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to list countries');
  }
  res.status(httpStatus.OK).send({
    success: true,
    countries: result.countries,
    cached: result.cached,
    provider: result.provider || telephonyService.getProviderName(),
  });
});

const buyNumber = catchAsync(async (req, res) => {
  const { number, countryIso, type, friendlyName } = req.body;
  const purchase = await companyPhoneNumberService.purchaseNumberForUser(req.user, {
    number,
    countryIso,
    type,
    friendlyName,
  });

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.PHONE_NUMBER_PURCHASE,
    EntityTypes.PHONE_NUMBER,
    purchase.number,
    {
      number: purchase.number,
      countryIso,
      type,
      retailMonthlyPrice: purchase.retailMonthlyPrice,
      subscriptionId: purchase.subscription?.id,
    },
    req
  );

  res.status(httpStatus.OK).send(purchase);
});

/** GET /v1/plivo/numbers/subscriptions — buyer's monthly number subscriptions. */
const getMySubscriptions = catchAsync(async (req, res) => {
  const numberSubscriptionService = await import('../services/numberSubscription.service.js');
  const uid = req.user._id || req.user.id;
  const { page, limit, status } = req.query;
  const result = await numberSubscriptionService.listSubscriptionsForUser(uid, {
    page,
    limit,
    status,
  });
  res.status(httpStatus.OK).send({
    success: true,
    results: result.results,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
    totalResults: result.totalResults,
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
  // Provider account ownership is not authorization — refuse another user's company number.
  if (!(await companyPhoneNumberService.isCallerIdAllowedForUser(req.user?.id || req.user?._id, callerId))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'That caller ID is not assigned to you.');
  }
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
 * POST /v1/plivo/sdk-token — mint a short-lived Voice / WebRTC access token.
 * When TELEPHONY_PROVIDER=twilio, signs a Twilio Access Token (VoiceGrant).
 * Optional body `{ platform: "ios"|"android" }` attaches the matching push
 * credential SID so the mobile Voice SDK can receive inbound CallInvites.
 */
const getSdkToken = catchAsync(async (req, res) => {
  const rawPlatform = req.body?.platform ?? req.query?.platform;
  const platform =
    rawPlatform === 'ios' || rawPlatform === 'android' ? rawPlatform : undefined;
  const result = await telephonyService.mintBrowserToken({
    uid: req.user.id,
    platform,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to mint WebRTC token');
  }
  res.status(httpStatus.OK).send({
    success: true,
    token: result.token,
    username: result.username,
    identity: result.identity,
    ...(typeof result.ttl === 'number' ? { ttl: result.ttl } : {}),
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
  const { toNumber, callerId, businessName, executionId: clientExecutionId } = req.body || {};
  const userId = req.user?.id || req.user?._id;
  // The browser SDK sends its own caller ID — gate it before Plivo ever sees it.
  if (!(await companyPhoneNumberService.isCallerIdAllowedForUser(userId, callerId))) {
    throw new ApiError(httpStatus.FORBIDDEN, 'That caller ID is not assigned to you.');
  }
  const result = await telephonyService.registerBrowserCallIntent({ toNumber, callerId });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_REQUEST, result.error || 'Invalid browser call intent');
  }

  const executionId =
    (clientExecutionId && String(clientExecutionId).trim()) ||
    `plivo_${userId || 'anon'}_${Date.now()}`;
  await callRecordService.assertDialerRecordMutationAllowed(executionId, userId);
  const record = await callRecordService.upsertDialerCallRecord({
    executionId,
    createdBy: userId || null,
    toPhoneNumber: toNumber,
    fromPhoneNumber: callerId,
    status: 'initiated',
    direction: 'outbound',
    provider: telephonyService.getProviderName(),
    businessName: businessName || undefined,
  });

  res.status(httpStatus.OK).send({ intent: result.intent, executionId, record });
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

/**
 * POST /v1/plivo/backfill-twilio — pull historical Twilio call logs + recordings
 * into CallRecords (source=backfill) and mirror audio to S3. Body: { limit?, force? }.
 */
const backfillTwilio = catchAsync(async (req, res) => {
  const { limit, force } = req.body || {};
  const { backfillTwilioDialerCalls } = await import('../services/callRecordingArchive.service.js');
  const result = await backfillTwilioDialerCalls({
    limit: Number(limit) || 200,
    force: Boolean(force),
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Twilio backfill failed');
  }
  res.status(httpStatus.OK).send(result);
});

/**
 * POST /v1/plivo/dialer-initiate — seed a dialer CallRecord when the web
 * softphone places an outbound call (Twilio CallSid or app-minted id for Plivo).
 */
const postDialerInitiate = catchAsync(async (req, res) => {
  const { executionId, toNumber, fromPhoneNumber, direction, businessName, status } = req.body || {};
  const userId = req.user?.id || req.user?._id;
  if (!executionId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'executionId is required');
  }

  const outboundDirection = (direction || 'outbound').toLowerCase();
  if (outboundDirection === 'outbound' && fromPhoneNumber) {
    if (!(await companyPhoneNumberService.isCallerIdAllowedForUser(userId, fromPhoneNumber))) {
      throw new ApiError(httpStatus.FORBIDDEN, 'That caller ID is not assigned to you.');
    }
  }

  await callRecordService.assertDialerRecordMutationAllowed(executionId, userId);
  const record = await callRecordService.upsertDialerCallRecord({
    executionId: String(executionId),
    createdBy: userId || null,
    toPhoneNumber: toNumber,
    fromPhoneNumber: fromPhoneNumber,
    status: status || 'initiated',
    direction: direction || 'outbound',
    provider: telephonyService.getProviderName(),
    businessName: businessName || undefined,
  });

  logger.info('[dialer] initiate recorded', {
    executionId,
    userId: userId ? String(userId) : null,
  });

  res.status(httpStatus.OK).send({ success: true, executionId: String(executionId), record });
});

/**
 * POST /v1/plivo/dialer-outcome — mark a dialer CallRecord terminal from the app
 * (reject / miss / cancel). Ensures call history updates when the user acts on
 * the native CallStyle notification before the Dial action webhook arrives.
 */
const postDialerOutcome = catchAsync(async (req, res) => {
  const { executionId, status, direction, fromPhoneNumber, toPhoneNumber, businessName } = req.body || {};
  const userId = req.user?.id || req.user?._id;
  if (!executionId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'executionId is required');
  }

  const normalizedStatus =
    status === 'cancelled' || status === 'canceled'
      ? 'no_answer'
      : status === 'rejected'
        ? 'declined'
        : status;

  await callRecordService.assertDialerRecordMutationAllowed(executionId, userId);
  const record = await callRecordService.upsertDialerCallRecord({
    executionId: String(executionId),
    createdBy: userId || null,
    status: normalizedStatus,
    direction: direction || undefined,
    fromPhoneNumber: fromPhoneNumber || undefined,
    toPhoneNumber: toPhoneNumber || undefined,
    provider: telephonyService.getProviderName(),
    businessName: businessName || undefined,
  });

  logger.info('[dialer] outcome recorded', {
    executionId,
    status: normalizedStatus,
    userId: userId ? String(userId) : null,
  });

  res.status(httpStatus.OK).send({ success: true, record });
});

export {
  getAvailableNumbers,
  getCountries,
  buyNumber,
  getMySubscriptions,
  getOwnedNumbers,
  placeCall,
  setCallRecording,
  backfillTwilio,
  postDialerInitiate,
  postDialerOutcome,
  answerCall,
  getSdkToken,
  sdkAnswer,
  postBrowserCallIntent,
};
