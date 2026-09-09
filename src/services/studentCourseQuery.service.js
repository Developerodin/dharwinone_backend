import mongoose from 'mongoose';
import TrainingModule from '../models/trainingModule.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import Mentor from '../models/mentor.model.js';
import User from '../models/user.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { wrap as wrapPresignedCache } from '../utils/presignedUrlCache.js';
import { refreshTrainingModuleCoverImages } from '../utils/trainingCoverImageUrl.js';
import logger from '../config/logger.js';

const signedDownloadUrl = wrapPresignedCache(generatePresignedDownloadUrl);

const MAX_PAGE_SIZE = 100;

const defaultProgressFields = {
  progress: { percentage: 0, lastAccessedAt: null, lastAccessedItem: null },
  quizScores: {},
  enrolledAt: null,
  startedAt: null,
  completedAt: null,
  status: 'enrolled',
  certificate: { issued: false, issuedAt: null, certificateId: null, certificateUrl: null },
};

/**
 * Mentor display label: user.name, else user.email.
 * @param {{ name?: string, email?: string } | null | undefined} user
 * @returns {string | null}
 */
const mentorUserDisplayLabel = (user) => {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email;
  return null;
};

/**
 * Display label for the first assigned mentor on a course card.
 * @param {Array<{ user?: { name?: string, email?: string } }>} mentorsAssigned
 * @returns {string}
 */
const primaryInstructorLabel = (mentorsAssigned) => {
  for (const mentor of mentorsAssigned || []) {
    const label = mentorUserDisplayLabel(mentor?.user);
    if (label) return label;
  }
  return 'Instructor';
};

/**
 * Distinct mentor labels for instructor filter facets (all mentors, deduped per course).
 * @param {Array<{ user?: { name?: string, email?: string } }>} mentorsAssigned
 * @returns {string[]}
 */
const collectInstructorFacetLabels = (mentorsAssigned) => {
  const labels = new Set();
  for (const mentor of mentorsAssigned || []) {
    const label = mentorUserDisplayLabel(mentor?.user);
    if (label) labels.add(label);
  }
  return [...labels];
};

/**
 * Mentor ids whose linked user display label matches the instructor chip.
 * @param {string} instructor
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
const mentorIdsForInstructorLabel = async (instructor) => {
  const label = String(instructor || '').trim();
  if (!label) return [];
  const users = await User.find({
    $or: [{ name: label }, { email: label }],
  })
    .select('_id')
    .lean();
  if (!users.length) return [];
  const mentors = await Mentor.find({ user: { $in: users.map((u) => u._id) } })
    .select('_id')
    .lean();
  return mentors.map((m) => m._id);
};

/** Aggregation expression: first mentor display label, or fallback. */
const instructorNameExpr = {
  $ifNull: [{ $arrayElemAt: ['$mentors.userName', 0] }, 'Instructor'],
};

/** $lookup mentors + users so instructorNameExpr can resolve mentor display labels. */
const mentorUserNameLookupStage = {
  $lookup: {
    from: 'mentors',
    localField: 'mentorsAssigned',
    foreignField: '_id',
    as: 'mentors',
    pipeline: [
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $project: { name: 1, email: 1 } }],
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          userName: {
            $let: {
              vars: { trimmedName: { $trim: { input: { $ifNull: ['$user.name', ''] } } } },
              in: {
                $cond: {
                  if: { $gt: [{ $strLenCP: '$$trimmedName' }, 0] },
                  then: '$$trimmedName',
                  else: { $ifNull: ['$user.email', 'Instructor'] },
                },
              },
            },
          },
        },
      },
    ],
  },
};

/**
 * Map UI sort keys to Mongo sort documents (recent = lastAccessed then enrolled).
 * @param {string} sortBy
 * @returns {Record<string, 1 | -1>}
 */
const mongoSortForCatalog = (sortBy) => {
  const key = String(sortBy || 'recent').trim();
  if (key === 'title' || key === 'moduleName:asc' || key === 'title:asc') {
    return { moduleName: 1 };
  }
  if (key === 'title-desc' || key === 'moduleName:desc' || key === 'title:desc') {
    return { moduleName: -1 };
  }
  if (key === 'enrolledAt:asc') {
    return { sortEnrolled: 1, moduleName: 1 };
  }
  if (key === 'enrolledAt:desc') {
    return { sortEnrolled: -1, moduleName: 1 };
  }
  if (key === 'lastAccessedAt:asc') {
    return { sortLastAccessed: 1, sortEnrolled: 1, moduleName: 1 };
  }
  return { sortLastAccessed: -1, sortEnrolled: -1, moduleName: 1 };
};

/**
 * Extra $match after progress is joined (status, search, category, instructor, progress band).
 * @param {object} filter
 * @returns {object | null}
 */
const buildPostJoinMatch = (filter) => {
  const clauses = [];
  if (filter.status) {
    clauses.push({ enrollmentStatus: filter.status });
  }
  if (filter.category) {
    clauses.push({ 'categories.name': filter.category });
  }
  const q = filter.search?.trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    clauses.push({
      $or: [{ moduleName: rx }, { instructorName: rx }],
    });
  }
  const band = filter.progress;
  if (band === 'not-started') {
    clauses.push({ progressPct: 0 });
  } else if (band === 'in-progress') {
    clauses.push({ progressPct: { $gt: 0, $lt: 100 } });
  } else if (band === 'completed') {
    clauses.push({ progressPct: 100 });
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

/**
 * Map one aggregation row to the student-courses list item (no playlist).
 * @param {object} row
 */
const mapCatalogRow = (row) => {
  const p = row.progressDoc;
  const categories = (row.categories || []).map((c) => ({
    id: c._id?.toString?.() ?? c.id,
    name: c.name,
  }));
  const base = p
    ? {
        progress: {
          percentage: p.progress?.percentage ?? 0,
          lastAccessedAt: p.progress?.lastAccessedAt ?? null,
          lastAccessedItem: p.progress?.lastAccessedItem ?? null,
        },
        quizScores: p.quizScores ?? {},
        enrolledAt: p.enrolledAt,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
        status: p.status || 'enrolled',
        certificate: p.certificate ?? defaultProgressFields.certificate,
      }
    : {
        ...defaultProgressFields,
        enrolledAt: row.createdAt || new Date(),
      };
  return {
    module: {
      id: row._id.toString(),
      moduleName: row.moduleName,
      shortDescription: row.shortDescription,
      coverImage: row.coverImage,
      categories,
      instructor: row.instructorName,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    ...base,
  };
};

/**
 * Distinct category / instructor labels for assigned modules (unfiltered) so
 * catalog dropdowns are not limited to the current page.
 * @param {mongoose.Types.ObjectId} studentOid
 * @returns {Promise<{ categories: string[], instructors: string[] }>}
 */
const loadCatalogFacets = async (studentOid) => {
  const docs = await TrainingModule.find({ students: studentOid })
    .select('categories mentorsAssigned')
    .populate('categories', 'name')
    .populate({
      path: 'mentorsAssigned',
      select: 'user',
      populate: { path: 'user', select: 'name email' },
    })
    .lean();
  const categorySet = new Set();
  const instructorSet = new Set();
  for (const doc of docs) {
    for (const cat of doc.categories || []) {
      if (cat?.name) categorySet.add(cat.name);
    }
    for (const label of collectInstructorFacetLabels(doc.mentorsAssigned)) {
      instructorSet.add(label);
    }
  }
  return {
    categories: [...categorySet].sort((a, b) => a.localeCompare(b)),
    instructors: [...instructorSet].sort((a, b) => a.localeCompare(b)),
  };
};

/**
 * Query assigned courses with Mongo skip/limit. List payload is lean (no playlist / roster).
 * @param {string} studentId
 * @param {object} filter
 * @param {object} options
 */
const queryStudentCourses = async (studentId, filter, options) => {
  const studentOid = new mongoose.Types.ObjectId(String(studentId));
  const limit = Math.min(Math.max(Number(options.limit) || 9, 1), MAX_PAGE_SIZE);
  const page = Math.max(Number(options.page) || 1, 1);
  const skip = (page - 1) * limit;
  const sort = mongoSortForCatalog(options.sortBy);
  const progressColl = StudentCourseProgress.collection.name;

  const pipeline = [{ $match: { students: studentOid } }];

  if (filter.instructor) {
    const mentorIds = await mentorIdsForInstructorLabel(filter.instructor);
    pipeline.push({
      $match: {
        mentorsAssigned: {
          $in: mentorIds.length ? mentorIds : [new mongoose.Types.ObjectId()],
        },
      },
    });
  }

  pipeline.push(
    {
      $project: {
        moduleName: 1,
        shortDescription: 1,
        coverImage: 1,
        categories: 1,
        mentorsAssigned: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
    {
      $lookup: {
        from: 'categories',
        localField: 'categories',
        foreignField: '_id',
        as: 'categories',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $lookup: {
        from: progressColl,
        let: { mid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$student', studentOid] }, { $eq: ['$module', '$$mid'] }],
              },
            },
          },
          {
            $project: {
              progress: 1,
              quizScores: 1,
              enrolledAt: 1,
              startedAt: 1,
              completedAt: 1,
              status: 1,
              certificate: 1,
            },
          },
          { $limit: 1 },
        ],
        as: 'progressDoc',
      },
    },
    mentorUserNameLookupStage,
    {
      $addFields: {
        progressDoc: { $arrayElemAt: ['$progressDoc', 0] },
        instructorName: instructorNameExpr,
      },
    },
    {
      $addFields: {
        progressPct: { $ifNull: ['$progressDoc.progress.percentage', 0] },
        enrollmentStatus: { $ifNull: ['$progressDoc.status', 'enrolled'] },
        sortLastAccessed: {
          $ifNull: ['$progressDoc.progress.lastAccessedAt', new Date(0)],
        },
        sortEnrolled: { $ifNull: ['$progressDoc.enrolledAt', '$createdAt'] },
      },
    }
  );

  const postMatch = buildPostJoinMatch(filter);
  if (postMatch) pipeline.push({ $match: postMatch });

  pipeline.push({
    $facet: {
      meta: [{ $count: 'total' }],
      rows: [{ $sort: sort }, { $skip: skip }, { $limit: limit }],
    },
  });

  const [agg, facets] = await Promise.all([
    TrainingModule.aggregate(pipeline),
    loadCatalogFacets(studentOid),
  ]);

  const bucket = agg[0] || { meta: [], rows: [] };
  const totalResults = bucket.meta[0]?.total ?? 0;
  const rows = bucket.rows || [];

  await refreshTrainingModuleCoverImages(rows, signedDownloadUrl, (error) => {
    logger.error('Failed to regenerate cover image URL:', error);
  });

  const totalPages = totalResults === 0 ? 0 : Math.ceil(totalResults / limit);

  return {
    results: rows.map(mapCatalogRow),
    page,
    limit,
    totalPages,
    totalResults,
    facets,
  };
};

export {
  queryStudentCourses,
  primaryInstructorLabel,
  mentorUserDisplayLabel,
  collectInstructorFacetLabels,
};
