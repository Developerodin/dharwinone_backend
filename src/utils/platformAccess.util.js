import User from '../models/user.model.js';

/**
 * @param {object | null | undefined} viewer - req.user
 * @returns {boolean}
 */
export const viewerSeesHiddenUsers = (viewer) => Boolean(viewer?.platformSuperUser);

/**
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
export const getDirectoryHiddenUserIds = async () => User.distinct('_id', { hideFromDirectory: true });
