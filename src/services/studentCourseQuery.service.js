import mongoose from 'mongoose';
import TrainingModule from '../models/trainingModule.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
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
  if (filter.instructor) {
    clauses.push({ instructorName: filter.instructor });
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
  const rows = await TrainingModule.aggregate([
    { $match: { students: studentOid } },
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
      $project: {
        names: '$categories.name',
        instructorName: {
          $ifNull: [{ $arrayElemAt: ['$categories.name', 0] }, 'Instructor'],
        },
      },
    },
  ]);
  const categorySet = new Set();
  const instructorSet = new Set();
  for (const row of rows) {
    for (const name of row.names || []) {
      if (name) categorySet.add(name);
    }
    if (row.instructorName) instructorSet.add(row.instructorName);
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

  const pipeline = [
    { $match: { students: studentOid } },
    {
      $project: {
        moduleName: 1,
        shortDescription: 1,
        coverImage: 1,
        categories: 1,
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
    {
      $addFields: {
        progressDoc: { $arrayElemAt: ['$progressDoc', 0] },
        instructorName: {
          $ifNull: [{ $arrayElemAt: ['$categories.name', 0] }, 'Instructor'],
        },
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
    },
  ];

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

export { queryStudentCourses };
