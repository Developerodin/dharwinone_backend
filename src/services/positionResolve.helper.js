import Position from '../models/position.model.js';

const escapeRegex = (v) => String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Resolve or create a Position by title with duplicate-key safe concurrency handling.
 * @param {string} title
 * @returns {Promise<import('mongoose').Types.ObjectId|null>}
 */
export const resolvePositionIdFromDesignationTitle = async (title) => {
  const trimmed = String(title || '').trim();
  if (!trimmed) return null;
  const nameRegex = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  let existing = await Position.findOne({ name: { $regex: nameRegex } }).select('_id').lean();
  if (existing?._id) return existing._id;
  try {
    const created = await Position.create({ name: trimmed });
    return created._id;
  } catch (err) {
    if (err?.code === 11000) {
      existing = await Position.findOne({ name: { $regex: nameRegex } }).select('_id').lean();
      return existing?._id ?? null;
    }
    throw err;
  }
};

export default { resolvePositionIdFromDesignationTitle };
