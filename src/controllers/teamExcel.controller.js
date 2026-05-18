import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as teamExcelService from '../services/teamExcel.service.js';
import TeamImportLog from '../models/teamImportLog.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';

export const importExcel = catchAsync(async (req, res) => {
  if (!req.file) throw new ApiError(httpStatus.BAD_REQUEST, 'No file uploaded');
  const result = await teamExcelService.runImport({
    buffer: req.file.buffer,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    currentUserId: req.user.id || req.user._id,
  });
  res.status(httpStatus.OK).json(result);
});

export const exportExcel = catchAsync(async (req, res) => {
  const filter = {};
  if (req.query.teamId) filter._id = req.query.teamId;
  if (req.query.department) filter.department = req.query.department;
  const buf = await teamExcelService.runExport({
    filter,
    includeInactive: req.query.includeInactive === 'true',
  });
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="teams-export-${date}.xlsx"`);
  res.send(buf);
});

export const downloadTemplate = catchAsync(async (req, res) => {
  const buf = teamExcelService.buildTemplateWorkbookBuffer();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="teams-import-template.xlsx"');
  res.send(buf);
});

export const listImportLogs = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);
  const [results, total] = await Promise.all([
    TeamImportLog.find({})
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('uploadedBy', 'name email')
      .lean(),
    TeamImportLog.countDocuments({}),
  ]);
  for (const r of results) {
    if (r.summaryFileKey) {
      r.summaryFileUrl = await generatePresignedDownloadUrl(r.summaryFileKey, 7 * 24 * 3600);
    }
  }
  res.json({
    results,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    totalResults: total,
  });
});
