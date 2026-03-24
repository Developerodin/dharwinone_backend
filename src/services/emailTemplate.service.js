import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { decodeEmailTemplateJson } from '../utils/decodeHtmlEntities.js';
import EmailTemplate from '../models/emailTemplate.model.js';
import User from '../models/user.model.js';
import * as roleService from './role.service.js';

/**
 * @param {string|import('mongoose').Types.ObjectId} targetUserId
 */
export async function assertUserIsAgent(targetUserId) {
  const agentRole = await roleService.getRoleByName('Agent');
  if (!agentRole) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Agent role is not configured');
  }
  const user = await User.findById(targetUserId).select('roleIds').lean();
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }
  const ids = (user.roleIds || []).map((id) => String(id));
  if (!ids.includes(String(agentRole._id))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Target user must have the Agent role');
  }
}

function mapPopulatedUser(u) {
  if (!u) return undefined;
  const id = u.id || u._id;
  return { id: id ? String(id) : undefined, name: u.name, email: u.email };
}

/**
 * @param {string|import('mongoose').Types.ObjectId} currentUserId
 */
export async function listTemplatesForAgent(currentUserId) {
  const own = await EmailTemplate.find({ user: currentUserId }).sort({ updatedAt: -1 });
  const sharedDocs = await EmailTemplate.find({
    isShared: true,
    user: { $ne: currentUserId },
  })
    .populate('user', 'name email')
    .sort({ updatedAt: -1 });

  const shared = sharedDocs.map((doc) => {
    const json = doc.toJSON();
    const owner = mapPopulatedUser(doc.user);
    delete json.user;
    return decodeEmailTemplateJson({ ...json, owner });
  });

  return {
    own: own.map((d) => decodeEmailTemplateJson(d.toJSON())),
    shared,
  };
}

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
export async function createTemplate(userId, body) {
  const doc = await EmailTemplate.create({
    user: userId,
    title: body.title,
    subject: body.subject ?? '',
    bodyHtml: body.bodyHtml,
    isShared: Boolean(body.isShared),
  });
  return decodeEmailTemplateJson(doc.toJSON());
}

/**
 * @param {string|import('mongoose').Types.ObjectId} currentUserId
 */
export async function getOwnedTemplateOrThrow(templateId, currentUserId) {
  const t = await EmailTemplate.findById(templateId);
  if (!t) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  }
  if (String(t.user) !== String(currentUserId)) {
    throw new ApiError(httpStatus.FORBIDDEN, 'You can only edit your own templates');
  }
  return t;
}

/**
 * @param {string|import('mongoose').Types.ObjectId} currentUserId
 */
export async function updateTemplateById(templateId, currentUserId, body) {
  const t = await getOwnedTemplateOrThrow(templateId, currentUserId);
  if (body.title !== undefined) t.title = body.title;
  if (body.subject !== undefined) t.subject = body.subject;
  if (body.bodyHtml !== undefined) t.bodyHtml = body.bodyHtml;
  if (body.isShared !== undefined) t.isShared = Boolean(body.isShared);
  await t.save();
  return decodeEmailTemplateJson(t.toJSON());
}

/**
 * @param {string|import('mongoose').Types.ObjectId} currentUserId
 */
export async function deleteTemplateById(templateId, currentUserId) {
  const t = await getOwnedTemplateOrThrow(templateId, currentUserId);
  await t.deleteOne();
}

export async function listTemplatesForAdminTarget(targetUserId) {
  await assertUserIsAgent(targetUserId);
  const rows = await EmailTemplate.find({ user: targetUserId }).sort({ updatedAt: -1 });
  return rows.map((d) => decodeEmailTemplateJson(d.toJSON()));
}

/**
 * @param {string|import('mongoose').Types.ObjectId} targetUserId
 */
export async function createTemplateForAdminTarget(targetUserId, body) {
  await assertUserIsAgent(targetUserId);
  const doc = await EmailTemplate.create({
    user: targetUserId,
    title: body.title,
    subject: body.subject ?? '',
    bodyHtml: body.bodyHtml,
    isShared: Boolean(body.isShared),
  });
  return decodeEmailTemplateJson(doc.toJSON());
}

export async function getTemplateByIdAdmin(templateId) {
  const t = await EmailTemplate.findById(templateId);
  if (!t) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  }
  return t;
}

export async function updateTemplateAdmin(templateId, body) {
  const t = await getTemplateByIdAdmin(templateId);
  if (body.title !== undefined) t.title = body.title;
  if (body.subject !== undefined) t.subject = body.subject;
  if (body.bodyHtml !== undefined) t.bodyHtml = body.bodyHtml;
  if (body.isShared !== undefined) t.isShared = Boolean(body.isShared);
  await t.save();
  return decodeEmailTemplateJson(t.toJSON());
}

export async function deleteTemplateAdmin(templateId) {
  const t = await getTemplateByIdAdmin(templateId);
  await t.deleteOne();
}
