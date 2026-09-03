import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';

export const QUIZ_SEQUENTIAL_LOCK_MESSAGE =
  'This quiz is locked. Please complete the previous module(s) in sequential order to unlock this assessment.';

/**
 * Group playlist items the same way the learn page groups courseSections.
 * @param {Array} playlist
 * @returns {{ keys: string[], groups: Map<string, { index: number, id: string }[]> }}
 */
const groupPlaylistSections = (playlist) => {
  const keys = [];
  const groups = new Map();
  (playlist || []).forEach((item, i) => {
    const title = typeof item.sectionTitle === 'string' ? item.sectionTitle.trim() : '';
    const key = title
      ? title
      : item.sectionIndex != null
        ? `section-${item.sectionIndex}`
        : '__none__';
    if (!groups.has(key)) {
      groups.set(key, []);
      keys.push(key);
    }
    groups.get(key).push({ index: i, id: String(i) });
  });
  return { keys, groups };
};

/**
 * True when a quiz cannot be taken yet: all prior sections must be complete,
 * and all items before the quiz in its own section must be complete.
 * @param {Array} playlist
 * @param {Iterable<string>} completedItemIds
 * @param {string} quizPlaylistItemId
 * @returns {boolean}
 */
const isQuizSequentiallyLocked = (playlist, completedItemIds, quizPlaylistItemId) => {
  const completed = completedItemIds instanceof Set ? completedItemIds : new Set([...(completedItemIds || [])].map(String));
  const quizId = String(quizPlaylistItemId);
  const list = playlist || [];
  const quizIndex = list.findIndex((_, i) => String(i) === quizId);
  if (quizIndex < 0) return false;

  const { keys, groups } = groupPlaylistSections(list);
  let sectionPos = -1;
  let indexInSection = -1;
  keys.forEach((key, sIdx) => {
    const idx = groups.get(key).findIndex((row) => row.id === quizId);
    if (idx >= 0) {
      sectionPos = sIdx;
      indexInSection = idx;
    }
  });

  const isDone = (id) => completed.has(String(id));

  if (sectionPos < 0) {
    for (let i = 0; i < quizIndex; i += 1) {
      if (!isDone(i)) return true;
    }
    return false;
  }

  for (let s = 0; s < sectionPos; s += 1) {
    const lectures = groups.get(keys[s]) || [];
    if (lectures.some((lec) => !isDone(lec.id))) return true;
  }
  const same = groups.get(keys[sectionPos]) || [];
  for (let j = 0; j < indexInSection; j += 1) {
    if (!isDone(same[j].id)) return true;
  }
  return false;
};

/**
 * Throw 403 when the student has not finished prior section content.
 * Reuses `module.playlist` (already loaded) and an optional progress doc — no roster populate.
 * @param {string} studentId
 * @param {object} module - TrainingModule with playlist
 * @param {string} playlistItemId
 * @param {{ progress?: { completedItems?: { playlistItemId?: string }[] } } | null} [progressDoc]
 */
const assertQuizUnlocked = async (studentId, module, playlistItemId, progressDoc) => {
  const progress =
    progressDoc !== undefined
      ? progressDoc
      : await StudentCourseProgress.findOne({ student: studentId, module: module._id || module.id })
          .select('progress.completedItems')
          .lean();
  const completedIds = (progress?.progress?.completedItems || []).map((c) => String(c.playlistItemId));
  if (isQuizSequentiallyLocked(module.playlist, completedIds, playlistItemId)) {
    throw new ApiError(httpStatus.FORBIDDEN, QUIZ_SEQUENTIAL_LOCK_MESSAGE);
  }
};

export { groupPlaylistSections, isQuizSequentiallyLocked, assertQuizUnlocked };
