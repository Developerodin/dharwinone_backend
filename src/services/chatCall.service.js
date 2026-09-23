import httpStatus from 'http-status';
import { AccessToken } from 'livekit-server-sdk';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import ChatCall from '../models/chatCall.model.js';
import { getConversationParticipantIds } from './chat.service.js';

const apiKey = config.livekit?.apiKey;
const apiSecret = config.livekit?.apiSecret;

/** Pre-accept states — HTTP createCall uses `initiated`; legacy paths use `ringing`. */
const PRE_CONNECT_STATUSES = ['initiated', 'ringing'];

const idStr = (x) => String(x?._id ?? x ?? '');

/** Participant ids other than the caller (ChatCall.participants normally includes the caller). */
const nonCallerIds = (call) => {
  const callerId = idStr(call?.caller);
  return [...new Set((call?.participants || []).map(idStr).filter((id) => id && id !== callerId))];
};

/** Caller plus every participant, deduped — the set of user rooms a call event goes to. */
const callMemberIds = (call) => {
  const callerId = idStr(call?.caller);
  return [...new Set([callerId, ...nonCallerIds(call)].filter(Boolean))];
};

const isGroupCall = (call) => nonCallerIds(call).length > 1;

/**
 * Load a call and assert the user belongs to it. Returns null when the call does not exist
 * (socket handlers treat that as "call no longer available"); throws 403 for non-members.
 * `allowCaller: false` is for accept/decline, which only make sense for someone being rung.
 */
const loadCallForMember = async (callId, userId, { allowCaller = true } = {}) => {
  const call = await ChatCall.findById(callId).lean();
  if (!call) return null;
  const uid = String(userId || '');
  const isCaller = idStr(call.caller) === uid;
  const isMember = isCaller || nonCallerIds(call).includes(uid);
  if (!uid || !isMember || (!allowCaller && isCaller)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant of this call');
  }
  return call;
};

/**
 * True when `userId` is the caller or a participant of a not-yet-finished ChatCall bound to this
 * LiveKit room. This — not any client flag — is what earns a chat-call-style full token grant
 * for rooms that are not `chat-<conversationId>-*` (ad-hoc `group-call-*` rooms).
 */
const isLiveCallMemberForRoom = async (roomName, userId) => {
  if (!roomName || !userId) return false;
  const call = await ChatCall.findOne({
    livekitRoom: roomName,
    status: { $in: [...PRE_CONNECT_STATUSES, 'ongoing'] },
  })
    .select('caller participants')
    .lean();
  return Boolean(call) && callMemberIds(call).includes(String(userId));
};

const mintP2PToken = async (roomName, participantIdentity, participantName) => {
  if (!apiKey || !apiSecret) throw new Error('LiveKit credentials not configured');
  const token = new AccessToken(apiKey, apiSecret, {
    identity: String(participantIdentity),
    name: String(participantName),
    ttl: '6h',
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  return token.toJwt();
};

/** Caller must already have passed ensureParticipant — this only writes the row. */
const initiateCall = async (conversationId, callerId, callType) => {
  const participantIds = await getConversationParticipantIds(conversationId);
  const call = await ChatCall.create({
    conversation: conversationId,
    caller: callerId,
    participants: participantIds,
    callType,
    status: 'ringing',
  });
  logger.info('[ChatCall] initiateCall', { callId: call._id, conversationId, callerId, callType });
  return call;
};

/**
 * Accept a call as a non-caller participant.
 *
 * The first accept atomically flips ringing → ongoing and assigns the room; tokens go to the
 * caller and the acceptor. A later accept (another group member, or the same user on a second
 * device) finds the call already ongoing and just gets its own token. Returns null when the
 * call is no longer joinable (ended, declined, cancelled, expired).
 */
const acceptCall = async (callId, userId) => {
  const existing = await loadCallForMember(callId, userId, { allowCaller: false });
  if (!existing) return null;
  const roomName =
    (existing.livekitRoom && String(existing.livekitRoom).trim()) ||
    `chat-${existing.conversation}-${callId}`;

  let call = null;
  let firstAccept = false;
  if (PRE_CONNECT_STATUSES.includes(existing.status)) {
    call = await ChatCall.findOneAndUpdate(
      { _id: callId, status: { $in: PRE_CONNECT_STATUSES } },
      { status: 'ongoing', startedAt: new Date(), livekitRoom: roomName },
      { new: true }
    )
      .populate('caller', 'name email')
      .populate('participants', 'name email');
    firstAccept = Boolean(call);
  }
  if (!call) {
    // Someone else answered first (or this is a second device) — join the running call.
    call = await ChatCall.findOne({ _id: callId, status: 'ongoing' })
      .populate('caller', 'name email')
      .populate('participants', 'name email');
  }
  if (!call) return null;

  const uid = String(userId);
  const callerId = idStr(call.caller);
  const nameById = new Map(
    [call.caller, ...(call.participants || [])].filter(Boolean).map((p) => [idStr(p), p.name || idStr(p)])
  );
  const recipients = firstAccept ? [...new Set([callerId, uid])] : [uid];
  const tokenEntries = await Promise.all(
    recipients.map(async (rid) => [rid, await mintP2PToken(call.livekitRoom, rid, nameById.get(rid) || rid)])
  );

  const tokens = Object.fromEntries(tokenEntries);
  logger.info('[ChatCall] acceptCall', { callId, roomName: call.livekitRoom, firstAccept, userId: uid });
  return { call, tokens, firstAccept };
};

/**
 * Decline as a non-caller participant.
 *  - 1:1: the call becomes `declined`.
 *  - group: the decliner is added to declinedBy; the call becomes `declined` only once every
 *    non-caller participant has declined. A group call that is already ongoing just records
 *    the decline (the member dismissed a ring for a call others are in).
 * Returns { call, allDeclined } or null when there was nothing to decline.
 */
const declineCall = async (callId, userId) => {
  const existing = await loadCallForMember(callId, userId, { allowCaller: false });
  if (!existing) return null;
  const uid = String(userId);

  if (!isGroupCall(existing)) {
    const call = await ChatCall.findOneAndUpdate(
      { _id: callId, status: { $in: PRE_CONNECT_STATUSES } },
      { $set: { status: 'declined', endedAt: new Date() }, $addToSet: { declinedBy: uid } },
      { new: true }
    ).lean();
    return call ? { call, allDeclined: true } : null;
  }

  const call = await ChatCall.findOneAndUpdate(
    { _id: callId, status: { $in: [...PRE_CONNECT_STATUSES, 'ongoing'] } },
    { $addToSet: { declinedBy: uid } },
    { new: true }
  ).lean();
  if (!call) return null;

  const declined = new Set((call.declinedBy || []).map(idStr));
  if (PRE_CONNECT_STATUSES.includes(call.status) && nonCallerIds(call).every((id) => declined.has(id))) {
    const final = await ChatCall.findOneAndUpdate(
      { _id: callId, status: { $in: PRE_CONNECT_STATUSES } },
      { $set: { status: 'declined', endedAt: new Date() } },
      { new: true }
    ).lean();
    if (final) return { call: final, allDeclined: true };
  }
  return { call, allDeclined: false };
};

/**
 * Caller stops ringing before anyone answered. `no_answer` is for the client's own ring
 * timeout and for the caller's socket dropping; anything else is an explicit `cancelled`.
 */
const cancelCall = async (callId, callerId, { status } = {}) => {
  const next = status === 'no_answer' ? 'no_answer' : 'cancelled';
  return ChatCall.findOneAndUpdate(
    { _id: callId, status: { $in: PRE_CONNECT_STATUSES }, caller: callerId },
    { status: next, endedAt: new Date() },
    { new: true }
  ).lean();
};

/**
 * End a call as a participant. Pre-accept: only the caller can end it (→ cancelled); a callee
 * who wants to stop ringing declines instead, so this is a no-op for them. Ongoing → completed.
 * Finished calls are never rewritten.
 */
const endCall = async (callId, userId) => {
  const call = await loadCallForMember(callId, userId);
  if (!call) return null;
  if (PRE_CONNECT_STATUSES.includes(call.status)) {
    if (idStr(call.caller) !== String(userId)) return null;
    return ChatCall.findOneAndUpdate(
      { _id: callId, status: { $in: PRE_CONNECT_STATUSES } },
      { status: 'cancelled', endedAt: new Date() },
      { new: true }
    ).lean();
  }
  if (call.status !== 'ongoing') return null;
  const endedAt = new Date();
  const duration = call.startedAt
    ? Math.round((endedAt.getTime() - new Date(call.startedAt).getTime()) / 1000)
    : 0;
  return ChatCall.findOneAndUpdate(
    { _id: callId, status: 'ongoing' },
    { status: 'completed', endedAt, duration },
    { new: true }
  ).lean();
};

/**
 * Reconcile stuck calls. Two failure modes:
 *   - ringing > RING_TIMEOUT_MS: callee never answered, neither side declined
 *     (e.g. browser crash, network drop). Mark no_answer and dismiss every ringing device.
 *   - ongoing > ONGOING_MAX_MS without endedAt: end signal lost. Force complete.
 *
 * Called by the callSync scheduler and lazily from the call list / call detail reads, so
 * environments without schedulers (staging) still never show an eternal ring.
 */
const RING_TIMEOUT_MS = 60 * 1000;
const ONGOING_MAX_MS = 6 * 60 * 60 * 1000;
// ponytail: per-call conditional updates (not one updateMany) so we only dismiss calls this
// sweep actually expired. Bounded per run; a backlog larger than this drains over later sweeps.
const RING_SWEEP_BATCH = 200;

const expireStaleCalls = async () => {
  const now = Date.now();
  const ringCutoff = new Date(now - RING_TIMEOUT_MS);
  const ongoingCutoff = new Date(now - ONGOING_MAX_MS);

  const stale = await ChatCall.find({ status: { $in: PRE_CONNECT_STATUSES }, createdAt: { $lte: ringCutoff } })
    .select('_id')
    .limit(RING_SWEEP_BATCH)
    .lean();

  const [expired, ongoingRes] = await Promise.all([
    Promise.all(
      stale.map((c) =>
        ChatCall.findOneAndUpdate(
          { _id: c._id, status: { $in: PRE_CONNECT_STATUSES } },
          { $set: { status: 'no_answer', endedAt: new Date() } },
          { new: true }
        ).lean()
      )
    ).then((rows) => rows.filter(Boolean)),
    ChatCall.updateMany(
      { status: 'ongoing', startedAt: { $lte: ongoingCutoff }, endedAt: null },
      [
        {
          $set: {
            status: 'completed',
            endedAt: '$$NOW',
            duration: {
              $round: [{ $divide: [{ $subtract: ['$$NOW', '$startedAt'] }, 1000] }, 0],
            },
          },
        },
      ]
    ),
  ]);

  if (expired.length) {
    try {
      // Lazy: chatSocket.service imports this module.
      // eslint-disable-next-line import/no-cycle
      const { emitCallDismiss } = await import('./chatSocket.service.js');
      await Promise.all(expired.map((c) => emitCallDismiss(c, 'no_answer')));
    } catch (err) {
      logger.warn(`[ChatCall] expireStaleCalls dismiss emit failed: ${err?.message}`);
    }
  }

  return {
    ringExpired: expired.length,
    ongoingExpired: ongoingRes?.modifiedCount || 0,
  };
};

export {
  PRE_CONNECT_STATUSES,
  callMemberIds,
  nonCallerIds,
  isGroupCall,
  isLiveCallMemberForRoom,
  mintP2PToken,
  initiateCall,
  acceptCall,
  declineCall,
  cancelCall,
  endCall,
  expireStaleCalls,
};
