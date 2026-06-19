import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import plivoService from '../services/plivo.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getAvailableNumbers = catchAsync(async (req, res) => {
  const { countryIso, type, pattern, services, city, region, limit, offset } = req.query;
  const result = await plivoService.searchAvailableNumbers({
    countryIso,
    type,
    pattern,
    services,
    city,
    region,
    limit,
    offset,
  });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to search Plivo numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    hasMore: result.hasMore,
    offset: result.offset,
    limit: result.limit,
    total: result.total,
  });
});

const buyNumber = catchAsync(async (req, res) => {
  const { number } = req.body;
  const result = await plivoService.buyNumber(number);
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to buy Plivo number');
  }

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
  const result = await plivoService.listOwnedNumbers({ type, alias, limit, offset });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to list Plivo numbers');
  }
  res.status(httpStatus.OK).send({
    success: true,
    numbers: result.numbers,
    total: result.total,
  });
});

/**
 * POST /v1/plivo/call — start a click-to-call bridge. Plivo rings the agent's own
 * phone, then dials the target showing the bought number as caller ID.
 */
const placeCall = catchAsync(async (req, res) => {
  const { toNumber, agentPhone, callerId } = req.body;
  const result = await plivoService.placeBridgeCall({ toNumber, agentPhone, callerId });
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
  if (!plivoService.verifyCallSignature(to, callerId, sig)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Invalid call signature');
  }
  res.type('text/xml').send(plivoService.bridgeAnswerXml({ toNumber: to, callerId }));
});

/**
 * POST /v1/plivo/sdk-token — mint a short-lived, outbound-only WebRTC access
 * token for the browser softphone. Self-provisions the shared Plivo Application
 * + endpoint on first call.
 */
const getSdkToken = catchAsync(async (req, res) => {
  const result = await plivoService.mintWebrtcToken({ uid: req.user.id });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_GATEWAY, result.error || 'Failed to mint WebRTC token');
  }
  res.status(httpStatus.OK).send({ success: true, token: result.token, username: result.username });
});

/**
 * POST /v1/public/plivo/sdk-answer — Plivo fetches this when a browser-SDK call
 * is placed (no auth — Plivo's servers hit it). Plivo passes the dialed number as
 * `To` and the chosen caller ID as the `X-PH-callerId` custom header. A real call
 * only reaches here from our token-authenticated endpoint; Plivo also enforces
 * that the caller ID is an owned number on <Dial>.
 */
const sdkAnswer = catchAsync(async (req, res) => {
  const src = { ...req.query, ...req.body };
  const to =
    src.To ?? src.to ?? src.DialBLegTo ?? src['SIP-H-To'] ?? src['X-Destination'] ?? '';
  const callerId =
    src['X-PH-callerId'] ??
    src['X-PH-CallerId'] ??
    src['x-ph-callerid'] ??
    src.CallerId ??
    src.callerId ??
    src.From ??
    '';
  const intentToken =
    src['X-PH-intent'] ?? src['X-PH-Intent'] ?? src['x-ph-intent'] ?? src.intent ?? '';
  const xml = await plivoService.sdkAnswerXml({ to, callerId, intentToken });
  if (!xml) {
    logger.warn(
      `Plivo sdk-answer Hangup — could not build Dial XML (to=${String(to).slice(0, 40)}, callerId=${String(callerId).slice(0, 20)}, keys=${Object.keys(src).join(',')})`
    );
  }
  res.type('text/xml').send(xml || '<Response><Hangup/></Response>');
  plivoService.resetWebrtcAnswerUrl().catch(() => {});
});

/**
 * POST /v1/plivo/browser-call-intent — register dest+callerId before browser SDK
 * client.call(). Plivo's sdk-answer webhook often omits X-PH-callerId.
 */
const postBrowserCallIntent = catchAsync(async (req, res) => {
  const { toNumber, callerId } = req.body;
  const result = await plivoService.registerBrowserCallIntent({ toNumber, callerId });
  if (!result.success) {
    throw new ApiError(httpStatus.BAD_REQUEST, result.error || 'Invalid browser call intent');
  }
  res.status(httpStatus.OK).send({ intent: result.intent });
});

export {
  getAvailableNumbers,
  buyNumber,
  getOwnedNumbers,
  placeCall,
  answerCall,
  getSdkToken,
  sdkAnswer,
  postBrowserCallIntent,
};
