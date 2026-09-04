import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import pick from '../utils/pick.js';
import {
  exportRecruitersToExcel,
  getRecruiterTemplateBuffer,
  importRecruitersFromExcel,
} from '../services/recruiterExcel.service.js';

const exportExcel = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search', 'names', 'domains', 'education', 'locations', 'email']);
  const options = pick(req.query, ['sortBy']);
  const { buffer, totalResults, capped, exportMax } = await exportRecruitersToExcel(
    filter,
    options,
    req.user
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=recruiters_export_${Date.now()}.xlsx`
  );
  if (totalResults != null) {
    res.setHeader('X-Export-Total-Results', String(totalResults));
  }
  if (capped != null) {
    res.setHeader('X-Export-Capped', capped ? 'true' : 'false');
  }
  if (exportMax != null) {
    res.setHeader('X-Export-Max-Rows', String(exportMax));
  }
  res.send(buffer);
});

const getTemplate = catchAsync(async (req, res) => {
  const buffer = await getRecruiterTemplateBuffer();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    'attachment; filename=recruiters_template.xlsx'
  );
  res.send(buffer);
});

const importExcel = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Excel file is required');
  }

  const result = await importRecruitersFromExcel(req.file.buffer);

  if (result.summary.failed === 0) {
    res.status(httpStatus.CREATED).send({
      message: 'All recruiters imported successfully',
      ...result,
    });
  } else if (result.summary.successful === 0) {
    res.status(httpStatus.BAD_REQUEST).send({
      message: 'Failed to import any recruiters',
      ...result,
    });
  } else {
    res.status(httpStatus.MULTI_STATUS).send({
      message: 'Some recruiters imported successfully, some failed',
      ...result,
    });
  }
});

export { exportExcel, getTemplate, importExcel };
