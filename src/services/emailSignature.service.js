import EmailSignature from '../models/emailSignature.model.js';
import { decodeEmailSignatureJson } from '../utils/decodeHtmlEntities.js';
import * as emailTemplateService from './emailTemplate.service.js';

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
export async function getOrCreateSignature(userId) {
  let doc = await EmailSignature.findOne({ user: userId });
  if (!doc) {
    doc = await EmailSignature.create({ user: userId, html: '', enabled: true });
  }
  return decodeEmailSignatureJson(doc.toJSON());
}

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
export async function updateSignature(userId, { html, enabled }) {
  const doc = await EmailSignature.findOne({ user: userId });
  if (!doc) {
    const created = await EmailSignature.create({
      user: userId,
      html: html !== undefined ? html : '',
      enabled: enabled !== undefined ? enabled : true,
    });
    return decodeEmailSignatureJson(created.toJSON());
  }
  if (html !== undefined) doc.html = html;
  if (enabled !== undefined) doc.enabled = enabled;
  await doc.save();
  return decodeEmailSignatureJson(doc.toJSON());
}

/**
 * @param {string|import('mongoose').Types.ObjectId} targetUserId
 */
export async function getSignatureForAdminTarget(targetUserId) {
  await emailTemplateService.assertUserIsAgent(targetUserId);
  return getOrCreateSignature(targetUserId);
}

/**
 * @param {string|import('mongoose').Types.ObjectId} targetUserId
 */
export async function updateSignatureAdmin(targetUserId, { html, enabled }) {
  await emailTemplateService.assertUserIsAgent(targetUserId);
  return updateSignature(targetUserId, { html, enabled });
}
