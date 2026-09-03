import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import User from '../models/user.model.js';
import Conversation from '../models/conversation.model.js';
import Message from '../models/message.model.js';
import ChatCall from '../models/chatCall.model.js';
import * as livekitService from './livekit.service.js';
import Recording from '../models/recording.model.js';
import { generatePresignedDownloadUrl, generatePresignedRecordingPlaybackUrl } from '../config/s3.js';
import logger from '../config/logger.js';
import {
  buildChatMessagePreview,
  defaultAttachmentContent,
  isGenericAttachmentPlaceholder,
} from '../utils/chatMessagePreview.js';
import { userHasReceipt } from '../utils/chatReceipts.js';
import { assertCanInitiateWith, lookupExactEmail } from './communicationAccess.service.js';

/** Same presigned TTL as user profilePicture (auth.controller, employee.service). */
const PROFILE_PICTURE_PRESIGN_TTL_SEC = 7 * 24 * 3600;

const viewerConversationPrefs = (participants, viewerUserId) => {
  const uid = String(viewerUserId || '');
  const mine = (participants || []).find((p) => participantRowUserId(p) === uid);
  return {
    muted: Boolean(mine?.muted),
    pinned: mine?.pinnedAt != null,
  };
};

const sanitizeParticipantsForClient = (participants) =>
  (participants || []).map((p) => {
    if (!p || typeof p !== 'object') return p;
    const { muted, pinnedAt, ...rest } = p;
    return rest;
  });

/**
 * Strip internal fields; for groups with an avatar key, attach fresh presigned URLs (same pattern as profile pic).
 * Supports legacy `avatarKey` in DB until migrated by a new upload.
 * Viewer mute/pin are exposed at conversation level only (not on other participants).
 */
const formatConversationForClient = async (conv, viewerUserId) => {
  if (!conv) return conv;
  const prefs = viewerConversationPrefs(conv.participants, viewerUserId);
  const out = {
    ...conv,
    id: conv.id || conv._id?.toString(),
    muted: prefs.muted,
    pinned: prefs.pinned,
  };
  delete out._id;
  delete out.avatarKey;
  delete out.myParticipant;
  delete out.isPinned;
  out.participants = sanitizeParticipantsForClient(out.participants);

  if (conv.type === 'group') {
    const key = conv.avatar?.key || conv.avatarKey;
    if (key) {
      try {
        const freshUrl = await generatePresignedDownloadUrl(key, PROFILE_PICTURE_PRESIGN_TTL_SEC);
        out.avatar = {
          key,
          url: freshUrl,
          originalName: conv.avatar?.originalName,
          size: conv.avatar?.size,
          mimeType: conv.avatar?.mimeType,
        };
        out.avatarUrl = freshUrl;
      } catch {
        // Same as profile pic: no public URL without a successful presign
      }
    } else {
      delete out.avatar;
    }
  } else {
    delete out.avatar;
  }
  return out;
};

const ensureParticipant = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found');
  const isParticipant = conv.participants?.some((p) => p.user.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  return conv;
};

const ensureAdmin = async (conversationId, userId) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');
  const participant = conv.participants?.find((p) => p.user.toString() === userId);
  const role = participant?.role || (conv.createdBy?.toString() === userId ? 'admin' : 'member');
  if (role !== 'admin') throw new ApiError(httpStatus.FORBIDDEN, 'Admin only');
  return conv;
};

const isCreator = (conv, userId) => String(conv.createdBy?._id || conv.createdBy || '') === String(userId);

const userIsPrivilegedChatParticipant = (u) => u && (u.hideFromDirectory || u.platformSuperUser);

const loadUserFlagsMapByIds = async (objectIds) => {
  const uniq = [...new Set(objectIds.map((id) => id?.toString?.()).filter(Boolean))];
  if (!uniq.length) return new Map();
  const oids = uniq.map((id) => new mongoose.Types.ObjectId(id));
  const users = await User.find({ _id: { $in: oids } })
    .select('hideFromDirectory platformSuperUser')
    .lean();
  return new Map(users.map((u) => [u._id.toString(), u]));
};

const participantRowUserId = (p) => {
  if (!p?.user) return '';
  if (typeof p.user === 'object' && p.user._id != null) return p.user._id.toString();
  return p.user.toString();
};

const assertCallerCanAddRestrictedParticipants = async (callerUserId, newParticipantObjectIds) => {
  const caller = await User.findById(callerUserId).select('platformSuperUser').lean();
  if (caller?.platformSuperUser) return;
  const flagMap = await loadUserFlagsMapByIds(newParticipantObjectIds);
  const hasRestricted = newParticipantObjectIds.some((oid) =>
    userIsPrivilegedChatParticipant(flagMap.get(oid.toString()))
  );
  if (hasRestricted) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You cannot add this user to the conversation');
  }
};

const getConversationParticipantIds = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) return [];
  return (conv.participants || []).map((p) => p.user.toString());
};

/** Same visibility rules as getMessages — per-user deleted-for-me hides from deleter only. */
const messageVisibilityFilter = (userId) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  return {
    $and: [
      // Hide messages this user deleted for themselves (new + legacy).
      {
        $nor: [{ hiddenFor: userObjectId }, { deletedFor: 'me', deletedBy: userObjectId }],
      },
      {
        $or: [
          { deletedAt: null },
          { deletedFor: 'everyone' },
          // Legacy delete-for-me by someone else — still visible to this user.
          { deletedFor: 'me', deletedBy: { $ne: userObjectId } },
        ],
      },
    ],
  };
};

/**
 * Chat-list / preview visibility: same personal hides as the thread, but exclude
 * "deleted for everyone" tombstones so the list never shows deleted copy.
 */
const messagePreviewVisibilityFilter = (userId) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  return {
    $and: [
      {
        $nor: [
          { hiddenFor: userObjectId },
          { deletedFor: 'me', deletedBy: userObjectId },
          { deletedFor: 'everyone' },
        ],
      },
      {
        $or: [
          { deletedAt: null },
          { deletedFor: 'me', deletedBy: { $ne: userObjectId } },
        ],
      },
    ],
  };
};

/**
 * Present a message to a specific viewer. Legacy delete-for-me by *another* user
 * must not surface as a tombstone (deletedAt) for this viewer.
 */
const presentMessageForUser = (msg, userId) => {
  if (!msg) return msg;
  const presented = { ...msg, id: msg._id?.toString?.() || msg.id };
  const deletedById = presented.deletedBy?._id?.toString?.() || presented.deletedBy?.toString?.();
  if (
    presented.deletedFor === 'me' &&
    deletedById &&
    userId &&
    deletedById !== String(userId)
  ) {
    presented.deletedAt = null;
    presented.deletedFor = null;
    presented.deletedBy = null;
  }
  // hiddenFor is server-side only — never needed by clients.
  delete presented.hiddenFor;
  return presented;
};

const formatLastMessagePreview = (lastMsg) => {
  if (!lastMsg) return null;
  const preview = buildChatMessagePreview(lastMsg);
  return {
    content: preview.text,
    sender: lastMsg.sender?.name,
    createdAt: lastMsg.createdAt,
    type: lastMsg.type,
    attachments: lastMsg.attachments,
  };
};

const getLastMessagePreview = async (conversationId, userId) => {
  const msg = await Message.findOne({
    conversation: new mongoose.Types.ObjectId(conversationId),
    ...messagePreviewVisibilityFilter(userId),
  })
    .sort({ createdAt: -1 })
    .populate('sender', 'name')
    .lean();
  if (!msg) return null;
  return formatLastMessagePreview({
    ...presentMessageForUser(msg, userId),
    sender: msg.sender ? { name: msg.sender.name } : undefined,
  });
};

/** Notify targets for a call — uses conversation members when linked, else call.participants. */
const getCallNotifyParticipantIds = async (call) => {
  if (call?.conversation) {
    return getConversationParticipantIds(String(call.conversation));
  }
  const ids = new Set();
  const callerId = toIdString(call?.caller);
  if (callerId) ids.add(callerId);
  for (const p of call?.participants || []) {
    const pid = toIdString(p);
    if (pid) ids.add(pid);
  }
  return [...ids];
};



/** Participant ids plus per-user mute, used when deciding whether to notify. */
const getConversationParticipantNotifyStates = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).select('participants').lean();
  if (!conv) return [];
  return (conv.participants || []).map((p) => ({
    id: p.user.toString(),
    muted: Boolean(p.muted),
  }));
};

/** Normalize Mongo id / populated user / string for comparisons */
const toIdString = (x) => {
  if (x == null || x === '') return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    if (x._id != null) return String(x._id);
    if (x.id != null) return String(x.id);
  }
  return String(x);
};

/**
 * Personal call log fields: direction relative to viewer, peer = other party (or group label).
 * Keeps existing caller, participants, conversation on the object.
 */
const enrichCallForViewer = (call, viewerUserId) => {
  const viewer = toIdString(viewerUserId);
  const callerId = toIdString(call.caller);
  const direction = callerId && viewer && callerId === viewer ? 'outgoing' : 'incoming';

  const conv = call.conversation;

  const participantUsers = (call.participants || []).map((p) => ({
    id: toIdString(p),
    name: (p && p.name) || 'Unknown',
    email: p && p.email,
  }));

  const isGroup =
    (conv && typeof conv === 'object' && conv.type === 'group') ||
    (!conv && participantUsers.length >= 3);

  const others = participantUsers.filter((p) => p.id && p.id !== viewer);

  let peer = { name: 'Unknown' };

  if (isGroup) {
    if (conv && typeof conv.name === 'string' && conv.name.trim()) {
      peer = { name: conv.name.trim(), isGroup: true };
    } else if (others.length > 0) {
      const firstName = others[0].name || 'Unknown';
      const remaining = Math.max(0, participantUsers.length - 1);
      const name =
        remaining > 0
          ? `${firstName} + ${remaining} member${remaining !== 1 ? 's' : ''}`
          : firstName;
      peer = { name, isGroup: true };
    } else {
      peer = { name: 'Group', isGroup: true };
    }
  } else if (others.length === 1) {
    peer = { id: others[0].id, name: others[0].name, email: others[0].email };
  } else if (others.length > 1) {
    peer = {
      name: others
        .map((o) => o.name)
        .filter(Boolean)
        .join(', ') || 'Unknown',
      isGroup: true,
    };
  } else if (direction === 'incoming' && call.caller && typeof call.caller === 'object') {
    peer = {
      id: callerId,
      name: call.caller.name || 'Unknown',
      email: call.caller.email,
    };
  } else if (direction === 'outgoing' && call.caller && typeof call.caller === 'object' && callerId !== viewer) {
    peer = {
      id: callerId,
      name: call.caller.name || 'Unknown',
      email: call.caller.email,
    };
  }

  return { direction, peer };
};

const listConversations = async (userId, { page = 1, limit = 20, type } = {}) => {
  const skip = (page - 1) * limit;
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const matchFilter = { 'participants.user': userObjectId };
  if (type === 'direct' || type === 'group') {
    matchFilter.type = type;
  }

  const [ranked, total] = await Promise.all([
    Conversation.aggregate([
      { $match: matchFilter },
      {
        $addFields: {
          myParticipant: {
            $arrayElemAt: [
              {
                $filter: {
                  input: '$participants',
                  as: 'p',
                  cond: { $eq: ['$$p.user', userObjectId] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          isPinned: {
            $cond: [{ $gt: [{ $ifNull: ['$myParticipant.pinnedAt', null] }, null] }, 1, 0],
          },
        },
      },
      { $sort: { isPinned: -1, lastMessageAt: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { _id: 1 } },
    ]),
    Conversation.countDocuments(matchFilter),
  ]);

  const rankedIds = ranked.map((row) => row._id);
  const unordered =
    rankedIds.length > 0
      ? await Conversation.find({ _id: { $in: rankedIds } })
          .populate('participants.user', 'name email')
          .populate('createdBy', 'name email')
          .lean()
      : [];
  const byId = new Map(unordered.map((c) => [c._id.toString(), c]));
  const convs = rankedIds.map((id) => byId.get(id.toString())).filter(Boolean);

  const seenGroupKeys = new Set();
  const dedupedConvs = [];
  for (const c of convs) {
    if (c.type === 'group') {
      const participantIds = (c.participants || [])
        .map((p) => p.user?._id?.toString?.())
        .filter(Boolean)
        .sort()
        .join(',');
      const groupKey = `${c.name || 'Group'}|${participantIds}`;
      if (seenGroupKeys.has(groupKey)) continue;
      seenGroupKeys.add(groupKey);
    }
    dedupedConvs.push(c);
  }

  const convIds = dedupedConvs.map((c) => c._id);

  // Skip messages this user deleted for themselves, and skip "delete for everyone"
  // tombstones so the chat list never shows deleted content as the latest preview.
  const visibleLastMessageMatch = {
    conversation: { $in: convIds },
    ...messagePreviewVisibilityFilter(userId),
  };

  const lastMsgAgg = convIds.length
    ? await Message.aggregate([
        { $match: visibleLastMessageMatch },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$conversation',
            content: { $first: '$content' },
            type: { $first: '$type' },
            sender: { $first: '$sender' },
            createdAt: { $first: '$createdAt' },
            attachments: { $first: '$attachments' },
            deletedAt: { $first: '$deletedAt' },
            deletedFor: { $first: '$deletedFor' },
          },
        },
      ])
    : [];

  const senderIds = [...new Set(lastMsgAgg.map((m) => m.sender?.toString()).filter(Boolean))];
  const senders =
    senderIds.length > 0
      ? await User.find({ _id: { $in: senderIds.map((id) => new mongoose.Types.ObjectId(id)) } })
          .select('name')
          .lean()
      : [];
  const senderNameById = new Map(senders.map((s) => [s._id.toString(), s.name]));

  const lastMsgMap = new Map(
    lastMsgAgg.map((m) => [
      m._id.toString(),
      formatLastMessagePreview({
        content: m.content,
        type: m.type,
        createdAt: m.createdAt,
        attachments: m.attachments,
        deletedAt: m.deletedAt,
        deletedFor: m.deletedFor,
        sender: { name: senderNameById.get(m.sender?.toString()) },
      }),
    ])
  );

  const unreadPairs = await Promise.all(
    dedupedConvs.map(async (c) => {
      const myParticipant = c.participants?.find((p) => p?.user?._id?.toString() === userId);
      const query = {
        conversation: c._id,
        sender: { $ne: userObjectId },
      };
      if (myParticipant?.lastReadAt) {
        query.createdAt = { $gt: myParticipant.lastReadAt };
      }
      const count = await Message.countDocuments(query);
      return [c._id.toString(), count];
    })
  );
  const unreadMap = new Map(unreadPairs);

  const result = dedupedConvs.map((c) => {
    const cid = c._id.toString();
    const otherParticipants = (c.participants || []).filter((p) => p?.user?._id?.toString() !== userId);
    const displayName = c.type === 'group' ? (c.name || 'Group') : otherParticipants[0]?.user?.name || 'Unknown';
    return {
      ...c,
      id: cid,
      displayName,
      lastMessage: lastMsgMap.get(cid) || null,
      unreadCount: unreadMap.get(cid) || 0,
    };
  });

  const enrichedResults = await Promise.all(
    result.map((r) => formatConversationForClient({ ...r }, userId))
  );
  return { results: enrichedResults, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
};

const listConversationPreferences = async (userId) => {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const convs = await Conversation.find(
    { 'participants.user': userObjectId },
    { participants: 1 }
  ).lean();
  const muted = [];
  const pinned = [];
  for (const c of convs) {
    const mine = (c.participants || []).find((p) => String(p.user) === String(userId));
    if (!mine) continue;
    const id = c._id.toString();
    if (mine.muted) muted.push(id);
    if (mine.pinnedAt) pinned.push(id);
  }
  return { muted, pinned };
};

const createConversation = async (
  userId,
  { type, participantIds, name, description, email },
  viewer
) => {
  const creatorId = String(userId);

  // Restricted-role path: resolve the address server-side. grantedIds is request-local (spec §5.4).
  let grantedIds = new Set();
  let resolvedParticipantIds = participantIds;
  if (email) {
    if (type !== 'direct') {
      throw new ApiError(httpStatus.BAD_REQUEST, 'email is only valid for a direct conversation');
    }
    const target = await lookupExactEmail(userId, email);
    if (!target) {
      throw new ApiError(httpStatus.NOT_FOUND, 'No registered user found with that email');
    }
    resolvedParticipantIds = [String(target._id)];
    grantedIds = new Set(resolvedParticipantIds);
  }

  // Never include the creator twice — they are always prepended as owner/admin.
  const ids = [
    ...new Set(
      (resolvedParticipantIds || [])
        .map((id) => String(id))
        .filter((id) => id && id !== creatorId)
    ),
  ];
  if (type === 'direct' && ids.length !== 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Direct conversation requires exactly one other participant');
  }
  if (type === 'group' && ids.length < 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group requires at least one other participant');
  }

  const allParticipantIds = [userId, ...ids].map((id) => new mongoose.Types.ObjectId(id));
  const caller = await User.findById(userId).select('platformSuperUser').lean();
  const callerIsSuper = !!caller?.platformSuperUser;
  const flagMap = await loadUserFlagsMapByIds(allParticipantIds);
  const hasRestrictedInSet = allParticipantIds.some((oid) =>
    userIsPrivilegedChatParticipant(flagMap.get(oid.toString()))
  );

  if (hasRestrictedInSet && !callerIsSuper) {
    if (type === 'direct') {
      const existingEarly = await Conversation.findOne({
        type: 'direct',
        $and: allParticipantIds.map((id) => ({ 'participants.user': id })),
      })
        .populate('participants.user', 'name email')
        .lean();
      if (
        existingEarly &&
        (existingEarly.participants || []).some((p) => participantRowUserId(p) === userId)
      ) {
        return formatConversationForClient({ ...existingEarly, id: existingEarly._id?.toString() }, userId);
      }
    } else if (type === 'group') {
      const groupsEarly = await Conversation.find({
        type: 'group',
        'participants.user': { $all: allParticipantIds },
        'participants.0': { $exists: true },
      })
        .populate('participants.user', 'name email')
        .populate('createdBy', 'name email')
        .lean();
      const existingGroup = groupsEarly.find((g) => {
        const gIds = (g.participants || []).map((p) => p.user?._id?.toString?.()).filter(Boolean);
        return gIds.length === allParticipantIds.length && allParticipantIds.every((id) => gIds.includes(id.toString()));
      });
      if (existingGroup && (existingGroup.participants || []).some((p) => participantRowUserId(p) === userId)) {
        return formatConversationForClient({ ...existingGroup, id: existingGroup._id?.toString() }, userId);
      }
    }
    throw new ApiError(httpStatus.FORBIDDEN, 'You cannot start a conversation with this user');
  }

  if (type === 'direct') {
    const existing = await Conversation.findOne({
      type: 'direct',
      $and: allParticipantIds.map((id) => ({ 'participants.user': id })),
    })
      .populate('participants.user', 'name email')
      .lean();
    if (existing) return formatConversationForClient({ ...existing, id: existing._id?.toString() }, userId);
  }

  if (type === 'group') {
    const groups = await Conversation.find({
      type: 'group',
      'participants.user': { $all: allParticipantIds },
      'participants.0': { $exists: true },
    })
      .populate('participants.user', 'name email')
      .populate('createdBy', 'name email')
      .lean();
    const existing = groups.find((g) => {
      const gIds = (g.participants || []).map((p) => p.user?._id?.toString?.()).filter(Boolean);
      return gIds.length === allParticipantIds.length && allParticipantIds.every((id) => gIds.includes(id.toString()));
    });
    if (existing) return formatConversationForClient({ ...existing, id: existing._id?.toString() }, userId);
  }

  // ORDER IS LOAD-BEARING — spec §5.3. This assert MUST come after the dedup returns above.
  // A restricted user with a standing 1:1 and no shared group has canSeeUser === false, so
  // assert-first would 403 them out of reopening THEIR OWN existing conversation. Dedup-first
  // returns it and never reaches here. Do not "tidy" this by hoisting the assert.
  await assertCanInitiateWith(viewer, ids, { grantedIds });

  const participants = allParticipantIds.map((id, idx) => ({
    user: id,
    lastReadAt: null,
    ...(type === 'group' && idx === 0 ? { role: 'admin' } : {}),
  }));
  const conv = await Conversation.create({
    type,
    participants,
    name: type === 'group' ? name || 'Group' : undefined,
    description: type === 'group' ? String(description || '').trim().slice(0, 500) : undefined,
    createdBy: userId,
  });
  const populated = await conv.populate(['participants.user', 'createdBy']);
  const plain = populated.toObject();
  return formatConversationForClient({ ...plain, id: plain._id?.toString() }, userId);
};

const getConversation = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  let conv = await Conversation.findById(conversationId)
    .populate('participants.user', 'name email')
    .populate('createdBy', 'name email')
    .lean();
  if (!conv) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found');

  // Repair legacy groups that accidentally stored the creator twice.
  if (conv.type === 'group' && Array.isArray(conv.participants)) {
    const seen = new Set();
    const deduped = [];
    let changed = false;
    for (const p of conv.participants) {
      const uid = participantRowUserId(p);
      if (!uid) continue;
      if (seen.has(uid)) {
        changed = true;
        continue;
      }
      seen.add(uid);
      deduped.push(p);
    }
    if (changed) {
      await Conversation.findByIdAndUpdate(conversationId, {
        $set: {
          participants: deduped.map((p) => ({
            user: p.user?._id || p.user,
            lastReadAt: p.lastReadAt ?? null,
            role: p.role || 'member',
            muted: Boolean(p.muted),
            pinnedAt: p.pinnedAt ?? null,
          })),
        },
      });
      conv = await Conversation.findById(conversationId)
        .populate('participants.user', 'name email')
        .populate('createdBy', 'name email')
        .lean();
    }
  }

  return formatConversationForClient({ ...conv, id: conv._id?.toString() }, userId);
};

const getMessages = async (conversationId, userId, { before, limit = 50 }) => {
  await ensureParticipant(conversationId, userId);
  const filter = {
    conversation: new mongoose.Types.ObjectId(conversationId),
    ...messageVisibilityFilter(userId),
  };
  if (before) {
    const beforeDoc = await Message.findById(before);
    if (beforeDoc) filter.createdAt = { $lt: beforeDoc.createdAt };
  }
  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender createdAt', populate: { path: 'sender', select: 'name' } })
    .populate('reactions.user', 'name')
    .lean();
  const reversed = messages.reverse();
  // Regenerate presigned URLs for attachments (expire after 1h; old messages need fresh URLs)
  for (const m of reversed) {
    if (m.attachments?.length) {
      m.attachments = await Promise.all(
        m.attachments.map(async (a) => {
          if (a.key) {
            try {
              const url = await generatePresignedDownloadUrl(a.key, 3600);
              return { ...a, url };
            } catch {
              return a;
            }
          }
          return a;
        })
      );
    }
  }
  return reversed.map((m) => presentMessageForUser(m, userId));
};

const hydrateMessageAttachments = async (messages) => {
  for (const m of messages) {
    if (m.attachments?.length) {
      m.attachments = await Promise.all(
        m.attachments.map(async (a) => {
          if (a.key) {
            try {
              const url = await generatePresignedDownloadUrl(a.key, 3600);
              return { ...a, url };
            } catch {
              return a;
            }
          }
          return a;
        }),
      );
    }
  }
  return messages;
};

/**
 * Single message in a conversation if visible to the viewer.
 * Used to confirm a reply target exists before loading older pages to jump to it.
 */
const getConversationMessage = async (conversationId, messageId, userId) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({
    _id: messageId,
    conversation: new mongoose.Types.ObjectId(conversationId),
    ...messageVisibilityFilter(userId),
  })
    .populate('sender', 'name email')
    .populate({
      path: 'replyTo',
      select: 'content type sender createdAt',
      populate: { path: 'sender', select: 'name' },
    })
    .populate('reactions.user', 'name')
    .lean();

  if (!msg) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  }

  await hydrateMessageAttachments([msg]);
  return presentMessageForUser(msg, userId);
};

/**
 * Combined conversation timeline (messages + call logs), newest page first then
 * returned in chronological order. Single cursor: before = ISO createdAt of the
 * oldest item the client already has (optional beforeId + beforeKind for ties).
 */
const getConversationTimeline = async (
  conversationId,
  userId,
  { before, beforeId, beforeKind, limit = 20 } = {},
) => {
  await ensureParticipant(conversationId, userId);
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const beforeDate = before ? new Date(before) : null;
  const validBefore =
    beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : null;

  const messageFilter = {
    conversation: new mongoose.Types.ObjectId(conversationId),
    ...messageVisibilityFilter(userId),
  };
  const callFilter = {
    conversation: conversationId,
    $or: [{ caller: userId }, { participants: userId }],
  };

  // Inclusive upper bound; exact cursor row is removed in JS so same-ms ties work.
  if (validBefore) {
    messageFilter.createdAt = { $lte: validBefore };
    callFilter.createdAt = { $lte: validBefore };
  }

  const [rawMessages, rawCalls] = await Promise.all([
    Message.find(messageFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(take)
      .populate('sender', 'name email')
      .populate({
        path: 'replyTo',
        select: 'content type sender createdAt',
        populate: { path: 'sender', select: 'name' },
      })
      .populate('reactions.user', 'name')
      .lean(),
    ChatCall.find(callFilter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(take)
      .populate('caller', 'name email')
      .populate('participants', 'name email')
      .populate('roomJoinedUserIds', 'name email')
      .populate('conversation')
      .lean(),
  ]);

  await hydrateMessageAttachments(rawMessages);

  const kindRank = (kind) => (kind === 'call' ? 0 : 1);

  const compareDesc = (a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return tb - ta;
    const kr = kindRank(a.kind) - kindRank(b.kind);
    if (kr !== 0) return kr;
    return String(b.id).localeCompare(String(a.id));
  };

  const isStrictlyOlderThanCursor = (item) => {
    if (!validBefore) return true;
    if (!beforeId || !beforeKind) {
      return new Date(item.createdAt).getTime() < validBefore.getTime();
    }
    const cursorItem = {
      kind: beforeKind,
      id: beforeId,
      createdAt: validBefore,
    };
    // compareDesc(cursor, item) < 0 ⇒ cursor is newer ⇒ item is older.
    return compareDesc(cursorItem, item) < 0;
  };

  const merged = [
    ...rawMessages.map((m) => ({
      kind: 'message',
      id: m._id?.toString(),
      createdAt: m.createdAt,
      data: presentMessageForUser(m, userId),
    })),
    ...rawCalls.map((c) => {
      const item = { ...c, id: c._id?.toString() };
      Object.assign(item, enrichCallForViewer(item, userId));
      return {
        kind: 'call',
        id: item.id,
        createdAt: c.createdAt,
        data: item,
      };
    }),
  ]
    .filter(isStrictlyOlderThanCursor)
    .sort(compareDesc);

  const page = merged.slice(0, take);
  const hasMore =
    page.length >= take &&
    (merged.length > take || rawMessages.length >= take || rawCalls.length >= take);
  // Chronological (oldest → newest) within this page, matching getMessages.
  page.reverse();

  const oldest = page[0] || null;
  return {
    items: page,
    hasMore,
    nextBefore: oldest
      ? {
          before: new Date(oldest.createdAt).toISOString(),
          beforeId: oldest.id,
          beforeKind: oldest.kind,
        }
      : null,
  };
};

const createMessage = async (conversationId, userId, { content, type, attachments, replyTo }) => {
  await ensureParticipant(conversationId, userId);

  const msgType = type || (attachments?.length ? 'file' : 'text');
  let trimmed = (content || '').trim();
  if (attachments?.length && isGenericAttachmentPlaceholder(trimmed)) {
    trimmed = '';
  }

  const msgData = {
    conversation: conversationId,
    sender: userId,
    content: trimmed,
    type: msgType,
  };

  if (replyTo) {
    const replyMsg = await Message.findOne({ _id: replyTo, conversation: conversationId });
    if (replyMsg) msgData.replyTo = replyTo;
  }
  if (attachments && attachments.length > 0) {
    msgData.attachments = attachments.map((a) => ({
      url: a.url,
      key: a.key,
      originalName: a.originalName,
      size: a.size || 0,
      mimeType: a.mimeType || '',
    }));
    if (!msgData.content) {
      msgData.content = defaultAttachmentContent(msgType, msgData.attachments);
    }
  }

  const msg = await Message.create(msgData);
  await Conversation.findByIdAndUpdate(conversationId, { lastMessageAt: new Date() });
  const populated = await msg.populate([
    { path: 'sender', select: 'name email' },
    { path: 'replyTo', select: 'content type sender', populate: { path: 'sender', select: 'name' } },
  ]);
  const result = populated.toObject();
  result.id = result._id?.toString();
  return result;
};

/**
 * Latest message still visible to a user (excludes their "delete for me" and all
 * "delete for everyone" tombstones). Used for chat-list previews after deletion.
 */
const getLastVisibleMessageForUser = async (conversationId, userId) => {
  const msg = await Message.findOne({
    conversation: new mongoose.Types.ObjectId(conversationId),
    ...messagePreviewVisibilityFilter(userId),
  })
    .sort({ createdAt: -1 })
    .populate('sender', 'name')
    .lean();
  if (!msg) return null;
  const preview = buildChatMessagePreview(presentMessageForUser(msg, userId));
  return {
    content: preview.text,
    sender: msg.sender?.name || '',
    createdAt: msg.createdAt,
    type: msg.type,
    attachments: msg.attachments,
  };
};

const deleteMessage = async (conversationId, messageId, userId, { deleteFor }) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({ _id: messageId, conversation: conversationId }).lean();
  if (!msg) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');

  const isSender = msg.sender.toString() === userId.toString();
  const mode = deleteFor === 'everyone' ? 'everyone' : 'me';
  const userObjectId = new mongoose.Types.ObjectId(userId);

  // WhatsApp-style: anyone can delete for themselves; only the sender can delete for everyone.
  if (mode === 'everyone' && !isSender) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only the sender can delete this message for everyone');
  }

  // Already deleted for everyone — nothing more to do.
  if (msg.deletedAt && msg.deletedFor === 'everyone') {
    const result = { ...msg, id: msg._id?.toString() };
    return result;
  }

  if (mode === 'me') {
    // Per-user hide only — do NOT set deletedAt/deletedFor or other participants
    // would see a tombstone when the message is still returned to them.
    await Message.findByIdAndUpdate(messageId, {
      $addToSet: { hiddenFor: userObjectId },
    });
  } else {
    await Message.findByIdAndUpdate(messageId, {
      $set: {
        deletedAt: new Date(),
        deletedFor: 'everyone',
        deletedBy: userId,
      },
    });

    // Keep conversation sort key in sync when the chronologically latest message is removed for everyone.
    const latestVisible = await Message.findOne({
      conversation: conversationId,
      $or: [{ deletedAt: null }, { deletedFor: { $ne: 'everyone' } }],
    })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessageAt: latestVisible?.createdAt || null,
    });
  }

  const updated = await Message.findById(messageId)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender', populate: { path: 'sender', select: 'name' } })
    .lean();
  return presentMessageForUser(updated, userId);
};

/**
 * Forward a message (and its attachments) to one or more conversations.
 * @param {{ targetConversationId?: string, targetConversationIds?: string[] }} options
 */
const forwardMessage = async (conversationId, messageId, userId, options = {}) => {
  const rawTargets = Array.isArray(options.targetConversationIds)
    ? options.targetConversationIds
    : options.targetConversationId
      ? [options.targetConversationId]
      : [];
  const targetIds = [...new Set(rawTargets.map((id) => String(id)).filter(Boolean))];

  if (!targetIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Select at least one chat to forward to');
  }
  if (targetIds.some((id) => id === String(conversationId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Choose a different chat to forward to');
  }

  await ensureParticipant(conversationId, userId);
  for (const targetId of targetIds) {
    // eslint-disable-next-line no-await-in-loop
    await ensureParticipant(targetId, userId);
  }

  const source = await Message.findOne({ _id: messageId, conversation: conversationId }).lean();
  if (!source) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  if (source.deletedAt && source.deletedFor === 'everyone') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot forward a deleted message');
  }

  const attachments = [];
  for (const a of source.attachments || []) {
    let url = a.url;
    if (a.key) {
      try {
        // eslint-disable-next-line no-await-in-loop
        url = await generatePresignedDownloadUrl(a.key, 3600);
      } catch {
        /* keep existing url */
      }
    }
    if (!url) continue;
    attachments.push({
      url,
      key: a.key || '',
      originalName: a.originalName || 'attachment',
      size: a.size || 0,
      mimeType: a.mimeType || '',
    });
  }

  const hasMedia = attachments.length > 0;
  const caption = (source.content || '').trim();
  const msgType = hasMedia
    ? source.type && source.type !== 'text'
      ? source.type
      : 'file'
    : 'text';

  if (!hasMedia && !caption) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Nothing to forward');
  }

  const created = [];
  for (const targetId of targetIds) {
    // eslint-disable-next-line no-await-in-loop
    const msg = await createMessage(targetId, userId, {
      content: caption,
      type: msgType,
      attachments: hasMedia ? attachments : undefined,
    });
    created.push({ conversationId: targetId, message: msg });
  }
  return created;
};

const reactToMessage = async (conversationId, messageId, userId, { emoji }) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({ _id: messageId, conversation: conversationId });
  if (!msg) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  const reactions = (msg.reactions || []).filter((r) => r.user.toString() !== userId);
  if (emoji) {
    reactions.push({ user: userId, emoji: emoji || '👍' });
  }
  msg.reactions = reactions;
  await msg.save();
  const populated = await Message.findById(messageId)
    .populate('sender', 'name email')
    .populate({ path: 'replyTo', select: 'content type sender', populate: { path: 'sender', select: 'name' } })
    .populate('reactions.user', 'name')
    .lean();
  const result = { ...populated, id: populated._id?.toString() };
  return result;
};

const markAsRead = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const now = new Date();
  await Conversation.updateOne(
    { _id: conversationId, 'participants.user': userId },
    { $set: { 'participants.$.lastReadAt': now } }
  );

  const unread = await Message.find({
    conversation: conversationId,
    sender: { $ne: userId },
  })
    .select('_id readBy')
    .lean();

  const bulk = [];
  for (const msg of unread) {
    // Only record read here. Delivery timestamps come from message_delivered /
    // join_conversation so delivered/read times stay distinct.
    if (userHasReceipt(msg.readBy, userId)) continue;
    bulk.push({
      updateOne: {
        filter: { _id: msg._id },
        update: { $push: { readBy: { user: userId, at: now } } },
      },
    });
  }
  if (bulk.length) {
    await Message.bulkWrite(bulk, { ordered: false });
  }
  return { success: true, readAt: now.toISOString() };
};

/**
 * Mark a single message as delivered to a recipient (socket ACK).
 */
const markMessageDelivered = async (conversationId, messageId, userId) => {
  await ensureParticipant(conversationId, userId);
  const msg = await Message.findOne({ _id: messageId, conversation: conversationId })
    .select('sender deliveredTo')
    .lean();
  if (!msg) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found');
  if (String(msg.sender) === String(userId)) {
    return { already: true, messageId: String(messageId), userId: String(userId) };
  }
  if (userHasReceipt(msg.deliveredTo, userId)) {
    return { already: true, messageId: String(messageId), userId: String(userId) };
  }
  const at = new Date();
  await Message.updateOne(
    { _id: messageId },
    { $push: { deliveredTo: { user: userId, at } } }
  );
  return {
    messageId: String(messageId),
    conversationId: String(conversationId),
    userId: String(userId),
    senderId: String(msg.sender),
    deliveredAt: at.toISOString(),
  };
};

/**
 * Mark all messages in a conversation as delivered for this user (on join / fetch).
 */
const markConversationDelivered = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const pending = await Message.find({
    conversation: conversationId,
    sender: { $ne: userId },
  })
    .select('_id deliveredTo')
    .lean();

  const at = new Date();
  const bulk = [];
  const markedIds = [];
  for (const msg of pending) {
    if (userHasReceipt(msg.deliveredTo, userId)) continue;
    bulk.push({
      updateOne: {
        filter: { _id: msg._id },
        update: { $push: { deliveredTo: { user: userId, at } } },
      },
    });
    markedIds.push(String(msg._id));
  }
  if (bulk.length) {
    await Message.bulkWrite(bulk, { ordered: false });
  }
  return {
    conversationId: String(conversationId),
    userId: String(userId),
    deliveredAt: at.toISOString(),
    messageIds: markedIds,
  };
};

const listCallsForConversation = async (conversationId, userId, { before, limit = 50 } = {}) => {
  await ensureParticipant(conversationId, userId);
  const filter = {
    conversation: conversationId,
    $or: [{ caller: userId }, { participants: userId }],
  };
  if (before) {
    const beforeDoc = await ChatCall.findById(before).select('createdAt conversation').lean();
    if (
      beforeDoc &&
      String(beforeDoc.conversation) === String(conversationId) &&
      beforeDoc.createdAt
    ) {
      filter.createdAt = { $lt: beforeDoc.createdAt };
    }
  }
  const calls = await ChatCall.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email')
    .populate('conversation')
    .lean();
  return calls.map((c) => {
    const item = { ...c, id: c._id?.toString() };
    Object.assign(item, enrichCallForViewer(item, userId));
    return item;
  });
};

function buildChatCallStatusFilter(status, userId, { incomingMissedOnly = false } = {}) {
  if (!status || String(status).trim().toLowerCase() === 'all') return null;
  const statusNorm = String(status).trim().toLowerCase().replace(/-/g, '_');
  if (statusNorm === 'missed') {
    const missedStatuses = { status: { $in: ['missed', 'no_answer', 'canceled', 'cancelled'] } };
    if (incomingMissedOnly && userId) {
      return {
        $and: [missedStatuses, { caller: { $ne: userId } }],
      };
    }
    return missedStatuses;
  }
  if (statusNorm === 'declined') {
    return { status: { $in: ['declined', 'rejected', 'busy'] } };
  }
  return { status: String(status).trim() };
}

const listCalls = async (userId, { page = 1, limit = 20, isAdmin = false, search, status } = {}) => {
  // Reconcile stuck rings/ongoing before reading so the UI never shows a call
  // that's been "ringing" for an hour. Cheap bulk update; no-op when clean.
  // Lazy require to avoid the static cycle chat.service → chatCall.service → chat.service.
  try {
    // eslint-disable-next-line import/no-cycle
    const chatCallMod = await import('./chatCall.service.js');
    await chatCallMod.expireStaleCalls();
  } catch (err) {
    logger.warn(`[listCalls] expireStaleCalls failed: ${err?.message}`);
  }
  const skip = (page - 1) * limit;
  let filter = isAdmin ? {} : { $or: [{ caller: userId }, { participants: userId }] };

  const statusFilter = buildChatCallStatusFilter(status, userId, {
    incomingMissedOnly: !isAdmin,
  });
  if (statusFilter) {
    filter = filter.$and ? { $and: [...filter.$and, statusFilter] } : { $and: [filter, statusFilter] };
  }

  const searchTerm = typeof search === 'string' ? search.trim() : '';
  if (searchTerm) {
    const matchingUsers = await User.find({
      status: 'active',
      $or: [{ name: new RegExp(searchTerm, 'i') }, { email: new RegExp(searchTerm, 'i') }],
    })
      .select('_id')
      .limit(100)
      .lean();
    const matchingIds = matchingUsers.map((u) => u._id);
    if (matchingIds.length === 0) {
      return { results: [], page, limit, total: 0, totalPages: 0 };
    }
    filter = {
      $and: [
        filter,
        { $or: [{ caller: { $in: matchingIds } }, { participants: { $in: matchingIds } }] },
      ],
    };
  }
  const calls = await ChatCall.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email')
    .populate('conversation')
    .lean();
  const total = await ChatCall.countDocuments(filter);
  const results = [];
  for (const c of calls) {
    const item = { ...c, id: c._id?.toString() };
    if (c.recordingId) {
      try {
        const rec = await Recording.findById(c.recordingId).lean();
        if (rec && rec.status === 'completed' && rec.filePath) {
          item.recordingUrl = await generatePresignedRecordingPlaybackUrl(rec.filePath, 3600);
        }
      } catch {
        item.recordingUrl = null;
      }
    }
    results.push(item);
  }
  return {
    results,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
};

/** In-app Calls tab: always scoped to viewer participations; adds direction + peer */
const listCallsForUser = async (userId, { page = 1, limit = 20 } = {}) => {
  const skip = (page - 1) * limit;
  const filter = { $or: [{ caller: userId }, { participants: userId }] };
  const calls = await ChatCall.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email')
    .populate('conversation')
    .lean();
  const total = await ChatCall.countDocuments(filter);
  const results = [];
  for (const c of calls) {
    const item = { ...c, id: c._id?.toString() };
    if (c.recordingId) {
      try {
        const rec = await Recording.findById(c.recordingId).lean();
        if (rec && rec.status === 'completed' && rec.filePath) {
          item.recordingUrl = await generatePresignedRecordingPlaybackUrl(rec.filePath, 3600);
        }
      } catch {
        item.recordingUrl = null;
      }
    }
    Object.assign(item, enrichCallForViewer(item, userId));
    results.push(item);
  }
  return {
    results,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

const createCall = async (conversationId, userId, { callType }) => {
  const conv = await ensureParticipant(conversationId, userId);
  const roomName = `chat-${conversationId}-${Date.now()}`;
  const otherUserIds = (conv.participants || []).filter((p) => p.user.toString() !== userId).map((p) => p.user);
  const call = await ChatCall.create({
    conversation: conversationId,
    caller: userId,
    participants: [userId, ...otherUserIds],
    callType: callType || 'audio',
    status: 'initiated',
    livekitRoom: roomName,
    startedAt: new Date(),
  });
  const populated = await call.populate(['caller', 'participants', 'roomJoinedUserIds', 'conversation']);
  return { call: populated, roomName };
};

const getCallById = async (callId, userId) => {
  try {
    // eslint-disable-next-line import/no-cycle
    const chatCallMod = await import('./chatCall.service.js');
    await chatCallMod.expireStaleCalls();
  } catch (err) {
    logger.warn(`[getCallById] expireStaleCalls failed: ${err?.message}`);
  }

  const call = await ChatCall.findById(callId)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email')
    .populate('conversation')
    .lean();
  if (!call) throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  const callerId = call.caller?._id?.toString?.() ?? call.caller?.toString?.() ?? '';
  const isParticipant =
    callerId === userId ||
    call.participants?.some((p) => {
      const participantId = p?._id?.toString?.() ?? p?.toString?.() ?? '';
      return participantId === userId;
    });
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');

  const conversationId = call.conversation?._id?.toString?.() ?? call.conversation?.toString?.() ?? '';
  const item = {
    ...call,
    id: call._id?.toString?.(),
    conversationId: conversationId || undefined,
    livekitRoom: call.livekitRoom || undefined,
    roomName: call.livekitRoom || undefined,
  };
  Object.assign(item, enrichCallForViewer(item, userId));
  return item;
};

const updateCall = async (callId, userId, { status, duration, recordRoomJoin }) => {
  const call = await ChatCall.findById(callId).lean();
  if (!call) throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');

  const update = {};
  if (status) update.status = status;
  if (duration != null) update.duration = duration;
  if (status === 'completed' || status === 'missed' || status === 'declined' || status === 'ended') {
    update.endedAt = new Date();
  }

  const mongoUpdate = {};
  if (Object.keys(update).length) mongoUpdate.$set = update;
  if (recordRoomJoin === true) {
    mongoUpdate.$addToSet = { roomJoinedUserIds: new mongoose.Types.ObjectId(userId) };
  }
  if (!mongoUpdate.$set && !mongoUpdate.$addToSet) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No valid updates');
  }

  const updated = await ChatCall.findByIdAndUpdate(callId, mongoUpdate, { new: true })
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email');
  return updated;
};

/**
 * Start LiveKit Egress recording for an in-app chat call.
 * User must be a participant. Call must have livekitRoom and be ongoing.
 */
const startChatCallRecording = async (callId, userId) => {
  const call = await ChatCall.findById(callId).lean();
  if (!call) throw new ApiError(httpStatus.NOT_FOUND, 'Call not found');
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p?.toString?.() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  if (!call.livekitRoom || !call.livekitRoom.trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Call has no LiveKit room');
  }
  const result = await livekitService.startRecording(call.livekitRoom);
  return result;
};

/**
 * Get active call for conversation - only returns if LiveKit room has participants (call is truly active)
 */
const getActiveCallForConversation = async (conversationId, userId) => {
  await ensureParticipant(conversationId, userId);
  const calls = await ChatCall.find({
    conversation: conversationId,
    $or: [{ caller: userId }, { participants: userId }],
    status: { $in: ['initiated', 'ringing', 'ongoing'] },
    livekitRoom: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('caller', 'name email')
    .populate('participants', 'name email')
    .populate('roomJoinedUserIds', 'name email')
    .populate('conversation')
    .lean();

  for (const c of calls) {
    if (!c.livekitRoom) continue;
    const count = await livekitService.getRoomParticipantCount(c.livekitRoom);
    if (count > 0) {
      return {
        ...c,
        id: c._id?.toString?.(),
        liveParticipantCount: count,
      };
    }
  }
  return null;
};

/**
 * Start a group call without creating a chat group.
 *
 * If an existing group conversation with exactly [caller + participantIds] already
 * exists, the call is linked to that conversation (so call history shows the group).
 * Otherwise the call is created with conversation = null — no group chat is made.
 *
 * Returns { call, roomName, conversationId? }
 */
const createGroupCall = async (userId, { participantIds, callType }, viewer) => {
  // FIRST statement. This endpoint accepted arbitrary user ids with no conversation context and
  // then rang each target's device — the most severe of the bypasses in spec §5.1. The assert
  // must precede any socket emission. Invariant I-3 (spec §4).
  const otherIds = (participantIds || []).map(String).filter((id) => id !== String(userId));
  await assertCanInitiateWith(viewer, otherIds);

  const creatorId = String(userId);
  const othersIds = [
    ...new Set(
      (participantIds || [])
        .map((id) => String(id))
        .filter((id) => id && id !== creatorId),
    ),
  ];

  if (othersIds.length < 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one other participant is required');
  }

  const allIds = [creatorId, ...othersIds];
  const allObjectIds = allIds.map((id) => new mongoose.Types.ObjectId(id));

  // Attempt to find an existing group conversation with exactly these members.
  let conversationId = null;
  let groupName = null;
  const groups = await Conversation.find({
    type: 'group',
    'participants.user': { $all: allObjectIds },
    'participants.0': { $exists: true },
  })
    .select('participants name displayName')
    .lean();

  const exactGroup = groups.find((g) => {
    const gIds = (g.participants || [])
      .map((p) => p.user?.toString?.())
      .filter(Boolean);
    return (
      gIds.length === allObjectIds.length &&
      allObjectIds.every((id) => gIds.includes(id.toString()))
    );
  });

  if (exactGroup) {
    conversationId = exactGroup._id.toString();
    groupName = exactGroup.displayName || exactGroup.name || null;
  }

  const roomName = conversationId
    ? `chat-${conversationId}-${Date.now()}`
    : `group-call-${Date.now()}`;

  const call = await ChatCall.create({
    ...(conversationId ? { conversation: conversationId } : {}),
    caller: userId,
    participants: allObjectIds,
    callType: callType || 'audio',
    status: 'initiated',
    livekitRoom: roomName,
    startedAt: new Date(),
  });

  const populated = await call.populate(['caller', 'participants', 'roomJoinedUserIds', 'conversation']);
  return { call: populated, roomName, conversationId, groupName };
};

const endCallByRoom = async (roomName, userId) => {
  const call = await ChatCall.findOne({ livekitRoom: roomName }).lean();
  if (!call) return null;
  const isParticipant = call.caller.toString() === userId || call.participants?.some((p) => p.toString() === userId);
  if (!isParticipant) throw new ApiError(httpStatus.FORBIDDEN, 'Not a participant');
  const endedAt = new Date();
  const startedAt = call.startedAt ? new Date(call.startedAt) : new Date(call.createdAt);
  const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  await ChatCall.findByIdAndUpdate(call._id, {
    $set: { status: 'completed', endedAt, duration },
  });
  const conversationId = call.conversation?.toString?.();
  if (roomName.startsWith('chat-')) {
    await livekitService.deleteInterviewRoom(roomName).catch(() => {});
  }
  return {
    success: true,
    conversationId,
    roomName,
    callId: String(call._id),
    call,
  };
};

const addParticipants = async (conversationId, userId, { participantIds }, viewer) => {
  await ensureAdmin(conversationId, userId);
  const ids = [...new Set((participantIds || []).map((id) => id.toString()))];
  if (!ids.length) throw new ApiError(httpStatus.BAD_REQUEST, 'participantIds required');

  const conv = await Conversation.findById(conversationId).lean();
  const existingIds = (conv.participants || []).map((p) => p.user.toString());
  const toAdd = ids.filter((id) => !existingIds.includes(id));
  if (!toAdd.length) return getConversation(conversationId, userId);

  // Discovery gate: you cannot add someone you cannot see. This is what closes the group-add
  // loophole — spec §5.5. Orthogonal to assertCallerCanAddRestrictedParticipants below, which
  // answers a different question (hidden / platform-super targets).
  await assertCanInitiateWith(viewer, toAdd.map(String));

  await assertCallerCanAddRestrictedParticipants(
    userId,
    toAdd.map((id) => new mongoose.Types.ObjectId(id))
  );

  const newParticipants = toAdd.map((id) => ({
    user: new mongoose.Types.ObjectId(id),
    lastReadAt: null,
    role: 'member',
  }));
  await Conversation.findByIdAndUpdate(conversationId, {
    $push: { participants: { $each: newParticipants } },
  });
  return getConversation(conversationId, userId);
};

const removeParticipant = async (conversationId, userId, targetUserId) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');

  const isSelf = targetUserId === userId;
  if (isSelf) {
    const participants = (conv.participants || []).filter((p) => p.user.toString() !== userId);
    if (participants.length === 0) {
      await Conversation.findByIdAndDelete(conversationId);
      return null;
    }
    await Conversation.findByIdAndUpdate(conversationId, {
      $pull: { participants: { user: new mongoose.Types.ObjectId(userId) } },
    });
    return null;
  }

  await ensureAdmin(conversationId, userId);
  if (conv.createdBy?.toString() === targetUserId) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot remove group creator');
  }
  const targetParticipant = conv.participants?.find((p) => p.user.toString() === targetUserId);
  const targetRole = targetParticipant?.role || (conv.createdBy?.toString() === targetUserId ? 'admin' : 'member');
  if (!isCreator(conv, userId) && targetRole === 'admin') {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only creator can remove admins');
  }
  await Conversation.findByIdAndUpdate(conversationId, {
    $pull: { participants: { user: new mongoose.Types.ObjectId(targetUserId) } },
  });
  return getConversation(conversationId, userId);
};

const setParticipantRole = async (conversationId, userId, targetUserId, { role }) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type !== 'group') throw new ApiError(httpStatus.BAD_REQUEST, 'Not a group');
  if (!isCreator(conv, userId)) throw new ApiError(httpStatus.FORBIDDEN, 'Only creator can change roles');
  if (conv.createdBy?.toString() === targetUserId) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot change creator role');
  }
  if (!['admin', 'member'].includes(role)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'role must be admin or member');
  }

  await Conversation.updateOne(
    { _id: conversationId, 'participants.user': new mongoose.Types.ObjectId(targetUserId) },
    { $set: { 'participants.$.role': role } }
  );
  return getConversation(conversationId, userId);
};

const updateGroupName = async (conversationId, userId, { name, description } = {}) => {
  await ensureAdmin(conversationId, userId);
  const $set = {};
  if (name !== undefined) {
    $set.name = String(name || '').trim() || 'Group';
  }
  if (description !== undefined) {
    $set.description = String(description || '').trim().slice(0, 500);
  }
  if (!Object.keys($set).length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Nothing to update');
  }
  await Conversation.findByIdAndUpdate(conversationId, { $set });
  return getConversation(conversationId, userId);
};

/** Persist full upload result like User.profilePicture (see uploadFileToS3 + personal-information flow). */
const setGroupConversationAvatar = async (conversationId, userId, uploadResult) => {
  await ensureAdmin(conversationId, userId);
  const avatar = {
    key: uploadResult.key,
    url: uploadResult.url,
    originalName: uploadResult.originalName,
    size: uploadResult.size,
    mimeType: uploadResult.mimeType,
  };
  await Conversation.findByIdAndUpdate(conversationId, {
    $set: { avatar },
    $unset: { avatarKey: '' },
  });
  return getConversation(conversationId, userId);
};

const setConversationPreferences = async (conversationId, userId, { muted, pinned } = {}) => {
  await ensureParticipant(conversationId, userId);
  if (typeof muted !== 'boolean' && typeof pinned !== 'boolean') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'muted or pinned is required');
  }
  const $set = {};
  if (typeof muted === 'boolean') {
    $set['participants.$.muted'] = muted;
  }
  if (typeof pinned === 'boolean') {
    $set['participants.$.pinnedAt'] = pinned ? new Date() : null;
  }
  await Conversation.updateOne(
    { _id: conversationId, 'participants.user': new mongoose.Types.ObjectId(userId) },
    { $set }
  );
  return getConversation(conversationId, userId);
};

const deleteConversation = async (conversationId, userId) => {
  const conv = await ensureParticipant(conversationId, userId);
  if (conv.type === 'group') {
    const creatorId = conv.createdBy?.toString?.();
    if (creatorId !== userId) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Only the group creator can delete the chat. You can leave the group instead.');
    }
  }
  const participantIds = (conv.participants || [])
    .map((p) => (p?.user?._id ? p.user._id.toString() : p?.user?.toString?.()))
    .filter(Boolean);
  await Conversation.findByIdAndDelete(conversationId);
  return { deleted: true, participantIds };
};

export {
  listConversations,
  listConversationPreferences,
  createConversation,
  getConversation,
  getConversationParticipantIds,
  getLastMessagePreview,
  getCallNotifyParticipantIds,
  getConversationParticipantNotifyStates,
  getMessages,
  getConversationMessage,
  getConversationTimeline,
  createMessage,
  deleteMessage,
  getLastVisibleMessageForUser,
  forwardMessage,
  reactToMessage,
  markAsRead,
  markMessageDelivered,
  markConversationDelivered,
  listCalls,
  listCallsForUser,
  listCallsForConversation,
  getActiveCallForConversation,
  getCallById,
  endCallByRoom,
  createCall,
  createGroupCall,
  updateCall,
  startChatCallRecording,
  ensureParticipant,
  addParticipants,
  removeParticipant,
  setParticipantRole,
  updateGroupName,
  setGroupConversationAvatar,
  setConversationPreferences,
  deleteConversation,
};
